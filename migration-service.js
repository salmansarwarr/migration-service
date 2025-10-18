// migration-service.js
// Backend service that listens for migration events and automatically migrates tokens
// Run with: node migration-service.js

import { Connection, PublicKey, Keypair, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import pkg from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN } = pkg
import {
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction,
    getMint,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import {
    Raydium,
    TxVersion,
    DEVNET_PROGRAM_ID,
    getCpmmPdaAmmConfigId
} from '@raydium-io/raydium-sdk-v2';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Helper function to read and parse JSON files
const readJsonFile = (filePath) => {
    const absolutePath = path.resolve(filePath);
    const fileContent = fs.readFileSync(absolutePath, 'utf-8');
    return JSON.parse(fileContent);
};

// Import your IDLs
const bondingCurveIDL = readJsonFile('./bonding_curve.json');
const lpLockIDL = readJsonFile('./lp_escrow.json');

// Configuration
const CONFIG = {
    BONDING_CURVE_PROGRAM_ID: new PublicKey(bondingCurveIDL.address),
    LP_LOCK_PROGRAM_ID: new PublicKey(lpLockIDL.address),
    PLATFORM_AUTHORITY: new PublicKey("35Bk7MrW3c17QWioRuABBEMFwNk4NitXRFBvkzYAupfF"),
    SOL_MINT: new PublicKey('So11111111111111111111111111111111111111112'),
    RPC_URL: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    MIGRATION_BOT_PRIVATE_KEY: process.env.MIGRATION_BOT_PRIVATE_KEY,
    CLUSTER: 'devnet', // or 'mainnet-beta'
};

// Track migrations in progress to prevent duplicates
const migrationsInProgress = new Set();

class MigrationService {
    constructor() {
        if (!CONFIG.MIGRATION_BOT_PRIVATE_KEY) {
            throw new Error('MIGRATION_BOT_PRIVATE_KEY environment variable not set');
        }

        this.connection = new Connection(CONFIG.RPC_URL, {
            commitment: 'confirmed',
            wsEndpoint: CONFIG.RPC_URL.replace('https', 'wss')
        });

        this.botWallet = Keypair.fromSecretKey(
            bs58.decode(CONFIG.MIGRATION_BOT_PRIVATE_KEY)
        );

        this.provider = new AnchorProvider(this.connection, {
            publicKey: this.botWallet.publicKey,
            signTransaction: async (tx) => {
                tx.sign(this.botWallet);
                return tx;
            },
            signAllTransactions: async (txs) => {
                txs.forEach(tx => tx.sign(this.botWallet));
                return txs;
            }
        }, {
            commitment: 'confirmed',
            preflightCommitment: 'confirmed'
        });

        this.program = new Program(bondingCurveIDL, this.provider);
        this.processedSignatures = new Set(); // Track processed transactions

        console.log('🤖 Migration Service Initialized');
        console.log(`   Bot Address: ${this.botWallet.publicKey.toString()}`);
        console.log(`   RPC URL: ${CONFIG.RPC_URL}`);
        console.log(`   Cluster: ${CONFIG.CLUSTER}`);
    }

    explorerUrl(tx) {
        const cluster = CONFIG.CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CONFIG.CLUSTER}`;
        return `https://explorer.solana.com/tx/${tx}${cluster}`;
    }

    async sendAndConfirmTransaction(transaction, signers) {
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');

        transaction.recentBlockhash = blockhash;
        transaction.feePayer = signers[0].publicKey;
        transaction.sign(...signers);

        const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
            preflightCommitment: 'confirmed',
        });

        await this.connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, 'confirmed');

        return signature;
    }

    async extractTokenMintFromLogs(signature) {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx) return null;

            const accountKeys = tx.transaction.message.staticAccountKeys || 
                               tx.transaction.message.accountKeys;

            // Find the bonding curve account in the transaction
            for (const key of accountKeys) {
                try {
                    const possibleCurve = await this.program.account.bondingCurve.fetch(
                        key
                    );
                    
                    if (possibleCurve) {
                        return possibleCurve.tokenMint;
                    }
                } catch {
                    continue;
                }
            }
        } catch (error) {
            console.error('Error extracting token mint:', error.message);
        }
        return null;
    }

    async autoMigrateToRaydium(mint) {
        const mintStr = mint.toString();

        // Prevent duplicate migrations
        if (migrationsInProgress.has(mintStr)) {
            console.log(`⚠️ Migration already in progress for ${mintStr}`);
            return;
        }

        migrationsInProgress.add(mintStr);

        try {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🚀 STARTING AUTO-MIGRATION FOR ${mintStr}`);
            console.log(`${'='.repeat(60)}\n`);

            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding_curve"), mint.toBuffer()],
                CONFIG.BONDING_CURVE_PROGRAM_ID
            );

            const [solVault] = PublicKey.findProgramAddressSync(
                [Buffer.from("sol_vault"), mint.toBuffer()],
                CONFIG.BONDING_CURVE_PROGRAM_ID
            );

            // Step 1: Migrate to Raydium (charges 5% fee)
            console.log("📋 Step 1: Calling migrate_to_raydium...");
            const migrateIx = await this.program.methods
                .migrateToRaydium()
                .accounts({
                    bondingCurve,
                    authority: this.botWallet.publicKey,
                    platformAuthority: CONFIG.PLATFORM_AUTHORITY,
                    bondingCurveSolVault: solVault,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();

            const migrateTx = new Transaction().add(migrateIx);
            const sig = await this.sendAndConfirmTransaction(migrateTx, [this.botWallet]);

            console.log("✅ Migration prepared:", this.explorerUrl(sig));

            // Refresh curve data
            const updatedCurveData = await this.program.account.bondingCurve.fetch(bondingCurve);

            // Step 2: Withdraw tokens and SOL for pool creation
            console.log("\n📋 Step 2: Withdrawing tokens and SOL for pool...");
            const [tokenVault] = PublicKey.findProgramAddressSync(
                [Buffer.from("token_vault"), mint.toBuffer()],
                CONFIG.BONDING_CURVE_PROGRAM_ID
            );

            const poolCreatorTokenAccount = await getAssociatedTokenAddress(
                mint,
                this.botWallet.publicKey,
                false,
                TOKEN_2022_PROGRAM_ID
            );

            const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
                this.botWallet.publicKey,
                poolCreatorTokenAccount,
                this.botWallet.publicKey,
                mint,
                TOKEN_2022_PROGRAM_ID
            );

            const withdrawIx = await this.program.methods
                .withdrawForPool()
                .accounts({
                    bondingCurve,
                    bondingCurveTokenVault: tokenVault,
                    bondingCurveSolVault: solVault,
                    tokenMint: mint,
                    destination: this.botWallet.publicKey,
                    destinationTokenAccount: poolCreatorTokenAccount,
                    authority: this.botWallet.publicKey,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();

            const withdrawTx = new Transaction().add(createAtaIx, withdrawIx);
            const sig1 = await this.sendAndConfirmTransaction(withdrawTx, [this.botWallet]);

            console.log("✅ Tokens & SOL withdrawn:", this.explorerUrl(sig1));
            console.log(`   Token Amount: ${updatedCurveData.migrationTokens.toString()}`);
            console.log(`   SOL Amount: ${updatedCurveData.migrationSol.toString()} lamports`);

            // Step 3: Create Raydium Pool
            console.log("\n📋 Step 3: Creating Raydium pool...");
            const raydium = await Raydium.load({
                owner: this.botWallet.publicKey,
                signAllTransactions: async (transactions) => {
                    return Promise.all(transactions.map(tx => {
                        tx.sign(this.botWallet);
                        return tx;
                    }));
                },
                connection: this.connection,
                cluster: CONFIG.CLUSTER,
                disableFeatureCheck: true,
                disableLoadToken: false,
                blockhashCommitment: 'finalized',
            });

            const mintA = await raydium.token.getTokenInfo(mint);
            const mintB = await raydium.token.getTokenInfo(CONFIG.SOL_MINT);

            const feeConfigs = await raydium.api.getCpmmConfigs();
            if (raydium.cluster === 'devnet') {
                feeConfigs.forEach((config) => {
                    config.id = getCpmmPdaAmmConfigId(
                        DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                        config.index
                    ).publicKey.toBase58();
                });
            }

            const { execute, extInfo } = await raydium.cpmm.createPool({
                programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
                mintA,
                mintB,
                mintAAmount: updatedCurveData.migrationTokens,
                mintBAmount: updatedCurveData.migrationSol,
                startTime: new BN(Math.floor(Date.now() / 1000)),
                feeConfig: feeConfigs[0],
                ownerInfo: {
                    useSOLBalance: true,
                },
                associatedOnly: false,
                txVersion: TxVersion.LEGACY,
                computeBudgetConfig: {
                    units: 600000,
                    microLamports: 200000
                },
            });

            const poolTx = await execute({ sendAndConfirm: true });

            console.log("✅ Raydium Pool Created:", this.explorerUrl(poolTx.txId));
            console.log(`   LP Mint: ${extInfo.address.lpMint}`);

            // Step 4: Lock 60% of LP tokens
            console.log("\n📋 Step 4: Locking LP tokens...");
            const lpMint = new PublicKey(extInfo.address.lpMint);

            try {
                await this.lockLPTokens(lpMint);
            } catch (lockError) {
                console.warn("⚠️ LP locking failed (pool was created successfully):", lockError.message);
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`✅ MIGRATION COMPLETE FOR ${mintStr}`);
            console.log(`${'='.repeat(60)}\n`);

            return {
                success: true,
                migrateTxid: sig,
                withdrawTxid: sig1,
                poolTxid: poolTx.txId,
                lpMint: extInfo.address.lpMint,
            };

        } catch (error) {
            console.error(`\n❌ Migration failed for ${mintStr}:`, error);
            throw error;
        } finally {
            // Always remove from in-progress set
            setTimeout(() => migrationsInProgress.delete(mintStr), 30000);
        }
    }

    async lockLPTokens(lpMint) {
        console.log("⏳ Waiting for LP tokens to arrive...");
        await new Promise(resolve => setTimeout(resolve, 3000));
    
        const lpLockProgram = new Program(lpLockIDL, this.provider);
    
        const [lockInfo] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock"), lpMint.toBuffer()],
            CONFIG.LP_LOCK_PROGRAM_ID
        );
    
        const [lockVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("lock_vault"), lpMint.toBuffer()],
            CONFIG.LP_LOCK_PROGRAM_ID
        );
    
        const mintInfo = await getMint(this.connection, lpMint, 'confirmed');
        const tokenProgramId = mintInfo.tlvData.length > 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    
        const fromTokenAccount = await getAssociatedTokenAddress(
            lpMint,
            this.botWallet.publicKey,
            false,
            tokenProgramId
        );
    
        // Retry logic to wait for LP tokens
        let retries = 5;
        let lpBalance;
    
        while (retries > 0) {
            try {
                lpBalance = await this.connection.getTokenAccountBalance(fromTokenAccount, 'confirmed');
    
                if (lpBalance && lpBalance.value.amount !== '0') {
                    console.log(`✅ LP Balance found: ${lpBalance.value.amount}`);
                    break;
                }
    
                console.log(`   Retry ${6 - retries}: Waiting for LP tokens...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries--;
            } catch (error) {
                console.log(`   Retry ${6 - retries}: LP account not found yet...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries--;
            }
        }
    
        if (!lpBalance || lpBalance.value.amount === '0') {
            throw new Error("LP tokens not found after retries");
        }
    
        const lockAmount = new BN(lpBalance.value.amount)
            .mul(new BN(60))
            .div(new BN(100));
    
        console.log(`   Locking ${lockAmount.toString()} LP tokens (60%)`);
    
        const userAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            this.botWallet.publicKey,
            fromTokenAccount,
            this.botWallet.publicKey,
            lpMint,
            tokenProgramId
        );
    
        const ixInitialize = await lpLockProgram.methods
            .initializeLock(
                lpMint,
                lockAmount,
                new BN(300),
                new BN(25000),
                CONFIG.PLATFORM_AUTHORITY
            )
            .accounts({
                lockInfo,
                authority: this.botWallet.publicKey,
                fromTokenAccount,
                tokenMint: lpMint,
                lockTokenAccount: lockVault,
                tokenProgram: tokenProgramId,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,  // ✅ Use actual rent sysvar, not SystemProgram
            })
            .instruction();
    
        const tx = new Transaction().add(userAtaIx, ixInitialize);
        const txid = await this.sendAndConfirmTransaction(tx, [this.botWallet]);
    
        console.log("✅ LP Tokens Locked:", this.explorerUrl(txid));
        return txid;
    }

    async start() {
        console.log('\n👂 Starting log listener for migration events...\n');

        // Test connection
        try {
            const slot = await this.connection.getSlot();
            console.log(`✅ Connection active (current slot: ${slot})`);
        } catch (error) {
            console.error('❌ Connection failed:', error);
            throw error;
        }

        // Listen for logs from the bonding curve program
        const subscriptionId = this.connection.onLogs(
            CONFIG.BONDING_CURVE_PROGRAM_ID,
            async (logInfo) => {
                // Skip if already processed
                if (this.processedSignatures.has(logInfo.signature)) {
                    return;
                }

                // Check if logs contain migration threshold message
                const hasMigrationEvent = logInfo.logs.some(log => 
                    log.includes('Migration threshold reached')
                );

                if (hasMigrationEvent && !logInfo.err) {
                    console.log(`\n🔔 MIGRATION EVENT DETECTED!`);
                    console.log(`   Signature: ${logInfo.signature}`);
                    console.log(`   Explorer: ${this.explorerUrl(logInfo.signature)}`);

                    // Mark as processed
                    this.processedSignatures.add(logInfo.signature);

                    // Extract token mint from transaction
                    console.log('   Extracting token mint from transaction...');
                    const tokenMint = await this.extractTokenMintFromLogs(logInfo.signature);

                    if (tokenMint) {
                        console.log(`   Token Mint: ${tokenMint.toString()}`);

                        // Wait a moment for transaction to finalize
                        await new Promise(resolve => setTimeout(resolve, 3000));

                        // Trigger migration
                        try {
                            await this.autoMigrateToRaydium(tokenMint);
                        } catch (error) {
                            console.error('Migration failed, will retry...');
                            await this.retryMigration(tokenMint, 3);
                        }
                    } else {
                        console.error('   ❌ Could not extract token mint from transaction');
                    }
                }
            },
            'confirmed'
        );

        console.log(`✅ Log listener active (Subscription ID: ${subscriptionId})`);
        console.log(`   Monitoring program: ${CONFIG.BONDING_CURVE_PROGRAM_ID.toString()}`);
        console.log('💤 Waiting for migration events...\n');

        // Heartbeat
        setInterval(() => {
            console.log(`💓 Heartbeat - ${new Date().toISOString()} - Processed: ${this.processedSignatures.size} events`);
        }, 60000);

        return subscriptionId;
    }

    async retryMigration(mint, maxRetries = 3) {
        for (let i = 1; i <= maxRetries; i++) {
            try {
                console.log(`\n🔄 Retry attempt ${i}/${maxRetries} for ${mint.toString()}`);
                await new Promise(resolve => setTimeout(resolve, 5000 * i));

                await this.autoMigrateToRaydium(mint);
                console.log(`✅ Migration succeeded on retry ${i}`);
                return true;
            } catch (error) {
                console.error(`❌ Retry ${i} failed:`, error.message);

                if (i === maxRetries) {
                    console.error(`🚨 All retries exhausted for ${mint.toString()}`);
                }
            }
        }
        return false;
    }
}

// Main execution
async function main() {
    try {
        const service = new MigrationService();
        const subscriptionId = await service.start();

        // Keep process running
        process.on('SIGINT', () => {
            console.log('\n\n📴 Shutting down gracefully...');
            service.connection.removeOnLogsListener(subscriptionId);
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            console.log('\n\n📴 Shutting down gracefully...');
            service.connection.removeOnLogsListener(subscriptionId);
            process.exit(0);
        });

    } catch (error) {
        console.error('💥 Failed to start migration service:', error);
        process.exit(1);
    }
}

main();