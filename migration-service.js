// unified-migration-unlock-service.js
// Combined service that:
// 1. Listens for migration threshold events
// 2. Auto-migrates tokens to Raydium
// 3. Burns LP tokens for permanent liquidity lock
// 4. Buys and burns NOOT tokens with platform fee
// 5. Monitors first buyer token locks and unlocks them when conditions are met

import { Connection, PublicKey, Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import pkg from '@coral-xyz/anchor';
const { AnchorProvider, Program, BN } = pkg;
import {
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction,
    getMint,
    TOKEN_PROGRAM_ID,
    createBurnInstruction,
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
import fetch from 'node-fetch';
import { swapAndBurnNoot } from './swap-and-burn.js';

dotenv.config();

// Helper function to read and parse JSON files
const readJsonFile = (filePath) => {
    const absolutePath = path.resolve(filePath);
    const fileContent = fs.readFileSync(absolutePath, 'utf-8');
    return JSON.parse(fileContent);
};

// Import IDLs
const bondingCurveIDL = readJsonFile('./bonding_curve.json');

// Configuration
const CONFIG = {
    BONDING_CURVE_PROGRAM_ID: new PublicKey(bondingCurveIDL.address),
    PLATFORM_AUTHORITY: new PublicKey("35Bk7MrW3c17QWioRuABBEMFwNk4NitXRFBvkzYAupfF"),
    SOL_MINT: new PublicKey('So11111111111111111111111111111111111111112'),
    RPC_URL: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    BOT_PRIVATE_KEY: process.env.MIGRATION_BOT_PRIVATE_KEY,
    CLUSTER: 'devnet',
    UNLOCK_CHECK_INTERVAL: 10 * 60 * 1000, // Check unlock conditions every 10 minutes
};

// Track migrations in progress to prevent duplicates
const migrationsInProgress = new Set();

class UnifiedMigrationUnlockService {
    constructor() {
        if (!CONFIG.BOT_PRIVATE_KEY) {
            throw new Error('PRIVATE_KEY environment variable not set');
        }

        this.connection = new Connection(CONFIG.RPC_URL, {
            commitment: 'confirmed',
            wsEndpoint: CONFIG.RPC_URL.replace('https', 'wss')
        });

        this.botWallet = Keypair.fromSecretKey(bs58.decode(CONFIG.BOT_PRIVATE_KEY));

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

        // State management
        this.processedSignatures = new Set();
        this.lockedTokens = new Map(); // Map<tokenMintAddress, tokenInfo>
        this.isRunning = false;
        this.migrationSubscriptionId = null;
        this.lockEventSubscriptionId = null;
        this.unlockMonitoringInterval = null;

        console.log('🤖 Unified Migration & Unlock Service Initialized');
        console.log(`   Bot Address: ${this.botWallet.publicKey.toString()} `);
        console.log(`   RPC URL: ${CONFIG.RPC_URL} `);
        console.log(`   Cluster: ${CONFIG.CLUSTER} `);
    }

    explorerUrl(tx) {
        const cluster = CONFIG.CLUSTER === 'mainnet-beta' ? '' : `? cluster = ${CONFIG.CLUSTER} `;
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

    // ==================== MIGRATION SECTION ====================

    async extractTokenMintFromLogs(signature) {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx) return null;

            const accountKeys = tx.transaction.message.staticAccountKeys ||
                tx.transaction.message.accountKeys;

            for (const key of accountKeys) {
                try {
                    const possibleCurve = await this.program.account.bondingCurve.fetch(key);
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

    async burnLPTokens(lpMint, lpTokenAccount, retries = 3) {
        try {
            console.log('\n🔥 Burning LP tokens for permanent liquidity lock...');

            const lpMintPubkey = new PublicKey(lpMint);
            const lpTokenAccountPubkey = new PublicKey(lpTokenAccount);

            // Retry logic with delays
            let lpAmount = '0';
            for (let i = 0; i < retries; i++) {
                try {
                    const tokenBalance = await this.connection.getTokenAccountBalance(lpTokenAccountPubkey);
                    lpAmount = tokenBalance.value.amount;

                    if (lpAmount !== '0') {
                        break; // Found balance, exit retry loop
                    }

                    console.log(`   ⏳ Attempt ${i + 1}/${retries}: No LP tokens yet, waiting...`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                } catch (error) {
                    if (i === retries - 1) throw error;
                    console.log(`   ⏳ Attempt ${i + 1}/${retries}: Account not found, waiting...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            if (lpAmount === '0') {
                console.log('⚠️ No LP tokens to burn after retries');
                return null;
            }

            console.log(`   LP tokens to burn: ${parseFloat(lpAmount) / 1e9}`);

            // Create burn instruction
            const burnInstruction = createBurnInstruction(
                lpTokenAccountPubkey,
                lpMintPubkey,
                this.botWallet.publicKey,
                BigInt(lpAmount),
                [],
                TOKEN_PROGRAM_ID
            );

            const burnTransaction = new Transaction().add(burnInstruction);
            const { blockhash } = await this.connection.getLatestBlockhash();
            burnTransaction.recentBlockhash = blockhash;
            burnTransaction.feePayer = this.botWallet.publicKey;

            burnTransaction.sign(this.botWallet);

            const burnTxid = await this.connection.sendRawTransaction(burnTransaction.serialize(), {
                skipPreflight: false,
                maxRetries: 2
            });

            await this.connection.confirmTransaction(burnTxid, 'confirmed');

            console.log(`✅ LP tokens burned: ${this.explorerUrl(burnTxid)}`);
            console.log(`   🔒 Liquidity is now PERMANENTLY LOCKED!`);

            return burnTxid;

        } catch (error) {
            console.error('❌ LP burn failed:', error.message);
            return null;
        }
    }

    async autoMigrateToRaydium(mint) {
        const mintStr = mint.toString();

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

            // Step 1: Migrate to Raydium
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

            const updatedCurveData = await this.program.account.bondingCurve.fetch(bondingCurve);

            // Calculate platform fee (3% of total SOL)
            const totalSol = updatedCurveData.migrationSol;
            const platformFee = Math.floor((totalSol * 3) / 100);

            console.log(`\n💰 Platform fee collected: ${platformFee / 1e9} SOL`);

            // Step 2: Withdraw tokens and SOL
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

            // Step 4: Burn LP Tokens
            console.log("\n📋 Step 4: Burning LP tokens...");

            const lpTokenAccount = await getAssociatedTokenAddress(
                new PublicKey(extInfo.address.lpMint),
                this.botWallet.publicKey,
                false,
                TOKEN_PROGRAM_ID
            );

            const burnLpTxid = await this.burnLPTokens(
                extInfo.address.lpMint,
                lpTokenAccount,
                5
            );

            // Step 5: Buy and Burn NOOT tokens with platform fee
            console.log("\n📋 Step 5: Buying and burning NOOT tokens...");

            let burnResult = null;
            if (CONFIG.CLUSTER === 'mainnet-beta' && platformFee > 0) {
                burnResult = await swapAndBurnNoot(
                    this.connection,
                    this.botWallet,
                    platformFee
                );

                if (burnResult.success) {
                    console.log(`✅ NOOT Buy & Burn Complete:`);
                    console.log(`   Swap TX: ${this.explorerUrl(burnResult.swapTxid)}`);
                    console.log(`   Burn TX: ${this.explorerUrl(burnResult.burnTxid)}`);
                    console.log(`   Burned: ${burnResult.burnedAmountFormatted} NOOT`);
                } else {
                    console.error(`⚠️ NOOT burn failed: ${burnResult.error}`);
                    console.log(`   Migration still successful, but burn failed`);
                }
            } else {
                console.log(`⚠️ Skipping NOOT burn (devnet or no fee collected)`);
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`✅ MIGRATION COMPLETE FOR ${mintStr}`);
            console.log(`   LP tokens burned = Liquidity locked forever ✅`);
            console.log(`   First buyer tokens remain locked until conditions met`);
            console.log(`${'='.repeat(60)}\n`);

            return {
                success: true,
                migrateTxid: sig,
                withdrawTxid: sig1,
                poolTxid: poolTx.txId,
                lpMint: extInfo.address.lpMint,
                burnLpTxid: burnLpTxid,
                platformFee: platformFee,
                burnResult: burnResult,
            };

        } catch (error) {
            console.error(`\n❌ Migration failed for ${mintStr}:`, error);
            throw error;
        } finally {
            setTimeout(() => migrationsInProgress.delete(mintStr), 30000);
        }
    }

    // ==================== UNLOCK MONITORING SECTION ====================

    addTokenToMonitoring(tokenMint, bondingCurve) {
        const tokenMintStr = tokenMint.toString();

        if (this.lockedTokens.has(tokenMintStr)) {
            return false;
        }

        const tokenInfo = {
            tokenMint: tokenMint,
            bondingCurve: bondingCurve,
            addedAt: Date.now(),
        };

        this.lockedTokens.set(tokenMintStr, tokenInfo);
        console.log(`\n🔒 Added to unlock monitoring: ${tokenMintStr.slice(0, 8)}...`);
        console.log(`   Bonding Curve: ${bondingCurve.toString().slice(0, 8)}...`);

        return true;
    }

    async getTokenHolderCount(mintAddress) {
        try {
            const res = await fetch(
                `https://data.solanatracker.io/tokens/${mintAddress}/holders`,
                {
                    headers: {
                        'x-api-key': '95a884b8-c416-4453-a028-38350cb0fa78'
                    }
                }
            );
            const data = await res.json();
            return data.total || 0;
        } catch (error) {
            console.error(`❌ Error fetching holder count:`, error.message);
            return 0;
        }
    }

    async getTradingVolume(mintAddress) {
        try {
            const response = await fetch(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
            );

            if (!response.ok) return 0;

            const data = await response.json();
            if (!data.pairs || data.pairs.length === 0) return 0;

            let totalVolume = 0;
            data.pairs.forEach((pair) => {
                totalVolume += parseFloat(pair.volume?.h24 || 0);
            });

            return totalVolume;
        } catch (error) {
            console.error(`❌ Error fetching volume:`, error.message);
            return 0;
        }
    }

    async batchUpdateData(tokenInfo, holderCount, volumeToAddCents) {
        try {
            const currentTime = Math.floor(Date.now() / 1000);

            const instruction = await this.program.methods
                .batchUpdateData(
                    new BN(holderCount),
                    new BN(currentTime),
                    new BN(volumeToAddCents),
                    new BN(currentTime)
                )
                .accounts({
                    bondingCurve: tokenInfo.bondingCurve,
                    oracleAuthority: this.botWallet.publicKey,
                })
                .instruction();

            const transaction = new Transaction().add(instruction);
            const signature = await this.sendAndConfirmTransaction(
                transaction,
                [this.botWallet]
            );

            return signature;
        } catch (error) {
            console.error(`❌ Batch update failed:`, error.message);
            throw error;
        }
    }

    async checkUnlockConditions(tokenInfo) {
        try {
            const instruction = await this.program.methods
                .checkUnlockConditions()
                .accounts({
                    bondingCurve: tokenInfo.bondingCurve,
                })
                .instruction();

            const transaction = new Transaction().add(instruction);
            await this.sendAndConfirmTransaction(transaction, [this.botWallet]);

            const bondingCurveData = await this.program.account.bondingCurve.fetch(tokenInfo.bondingCurve);

            return {
                unlockable: bondingCurveData.unlockable,
                currentHolders: bondingCurveData.currentHolderCount.toNumber(),
                requiredHolders: bondingCurveData.holderThreshold.toNumber(),
                currentVolume: bondingCurveData.totalVolumeUsd.toNumber(),
                requiredVolume: bondingCurveData.volumeThreshold.toNumber(),
            };
        } catch (error) {
            console.error(`❌ Check conditions failed:`, error.message);
            return {
                unlockable: false,
                currentHolders: 0,
                requiredHolders: 0,
                currentVolume: 0,
                requiredVolume: 0
            };
        }
    }

    async unlockFirstBuyerTokens(tokenInfo) {
        try {
            const bondingCurveData = await this.program.account.bondingCurve.fetch(tokenInfo.bondingCurve);
            const firstBuyer = bondingCurveData.firstBuyer;

            if (!firstBuyer) {
                throw new Error('No first buyer found');
            }

            const [firstBuyerLockVault] = PublicKey.findProgramAddressSync(
                [Buffer.from("first_buyer_lock_vault"), tokenInfo.tokenMint.toBuffer()],
                CONFIG.BONDING_CURVE_PROGRAM_ID
            );

            const mintInfo = await getMint(this.connection, tokenInfo.tokenMint);
            const tokenProgramId = mintInfo.tlvData.length > 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

            // Get first buyer's token account (create if needed)
            const firstBuyerTokenAccount = await getAssociatedTokenAddress(
                tokenInfo.tokenMint,
                firstBuyer,
                false,
                tokenProgramId
            );

            // Create ATA instruction if needed
            const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
                this.botWallet.publicKey,
                firstBuyerTokenAccount,
                firstBuyer,
                tokenInfo.tokenMint,
                tokenProgramId
            );

            const instruction = await this.program.methods
                .unlockFirstBuyerTokens()
                .accounts({
                    bondingCurve: tokenInfo.bondingCurve,
                    firstBuyerLockVault,
                    firstBuyerTokenAccount,
                    tokenMint: tokenInfo.tokenMint,
                    firstBuyer: this.botWallet.publicKey, // Bot calls it on behalf
                    tokenProgram: tokenProgramId,
                })
                .instruction();

            const transaction = new Transaction().add(createAtaIx, instruction);
            const signature = await this.sendAndConfirmTransaction(
                transaction,
                [this.botWallet]
            );

            console.log(`🔓 FIRST BUYER TOKENS RELEASED for ${tokenInfo.tokenMint.toString().slice(0, 8)}...`);
            console.log(`   Tokens returned to: ${firstBuyer.toString().slice(0, 8)}...`);
            console.log(`   Transaction: ${this.explorerUrl(signature)}`);

            return signature;
        } catch (error) {
            console.error(`❌ Unlock/release failed:`, error.message);
            throw error;
        }
    }

    async monitorSingleToken(tokenMintStr) {
        const tokenInfo = this.lockedTokens.get(tokenMintStr);
        if (!tokenInfo) return;

        try {
            const holderCount = await this.getTokenHolderCount(tokenMintStr);
            const recentVolume = await this.getTradingVolume(tokenMintStr);
            const volumeInCents = Math.floor(recentVolume * 100);

            if (holderCount > 0 || volumeInCents > 0) {
                await this.batchUpdateData(tokenInfo, holderCount, volumeInCents);
                console.log(`   ✓ Updated: ${holderCount} holders, $${(volumeInCents / 100).toFixed(2)} volume`);
            }

            const conditionCheck = await this.checkUnlockConditions(tokenInfo);

            if (conditionCheck.unlockable) {
                console.log(`🎉 CONDITIONS MET - RELEASING LOCKED TOKENS FOR ${tokenMintStr.slice(0, 8)}...`);
                await this.unlockFirstBuyerTokens(tokenInfo);
                this.lockedTokens.delete(tokenMintStr);
                return { status: 'unlocked' };
            }

            const holdersNeeded = Math.max(0, conditionCheck.requiredHolders - conditionCheck.currentHolders);
            const volumeNeeded = Math.max(0, (conditionCheck.requiredVolume - conditionCheck.currentVolume) / 100);

            console.log(`   ⏳ Need: ${holdersNeeded} holders, $${volumeNeeded.toFixed(2)} volume`);
            return { status: 'monitoring' };

        } catch (error) {
            console.error(`❌ Monitor error for ${tokenMintStr.slice(0, 8)}...:`, error.message);
            return { status: 'error' };
        }
    }

    async monitorAllLockedTokens() {
        if (this.lockedTokens.size === 0) {
            console.log('⚠️ No locked tokens to monitor');
            return;
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 Monitoring ${this.lockedTokens.size} locked token(s) - ${new Date().toLocaleString()}`);
        console.log(`${'='.repeat(60)}`);

        const promises = Array.from(this.lockedTokens.keys()).map(tokenMintStr => {
            console.log(`\n🔄 Checking ${tokenMintStr.slice(0, 8)}...`);
            return this.monitorSingleToken(tokenMintStr);
        });

        await Promise.allSettled(promises);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`✓ Unlock monitoring cycle complete`);
        console.log(`${'='.repeat(60)}\n`);
    }

    // ==================== SERVICE CONTROL ====================

    async start() {
        if (this.isRunning) {
            console.log('⚠️ Service is already running');
            return;
        }

        this.isRunning = true;

        console.log('\n🚀 Starting Unified Migration & Unlock Service...\n');

        // Test connection
        try {
            const slot = await this.connection.getSlot();
            console.log(`✅ Connection active (current slot: ${slot})`);
        } catch (error) {
            console.error('❌ Connection failed:', error);
            throw error;
        }

        // Listen for migration threshold events
        this.migrationSubscriptionId = this.connection.onLogs(
            CONFIG.BONDING_CURVE_PROGRAM_ID,
            async (logInfo) => {
                if (this.processedSignatures.has(logInfo.signature)) return;

                const hasMigrationEvent = logInfo.logs.some(log =>
                    log.includes('Migration threshold reached')
                );

                if (hasMigrationEvent && !logInfo.err) {
                    console.log(`\n🔔 MIGRATION EVENT DETECTED!`);
                    console.log(`   Signature: ${logInfo.signature}`);

                    this.processedSignatures.add(logInfo.signature);

                    const tokenMint = await this.extractTokenMintFromLogs(logInfo.signature);

                    if (tokenMint) {
                        console.log(`Token Mint: ${tokenMint.toString()}`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        try {
                            await this.autoMigrateToRaydium(tokenMint);
                        } catch (error) {
                            console.error('Migration failed:', error.message);
                        }
                    } else {
                        console.error('   ❌ Could not extract token mint');
                    }
                }
            },
            'confirmed'
        );

        console.log(`✅ Migration listener active`);
        console.log(`   Monitoring program: ${CONFIG.BONDING_CURVE_PROGRAM_ID.toString()}`);

        // Listen for FirstBuyerLocked events
        this.lockEventSubscriptionId = this.connection.onLogs(
            CONFIG.BONDING_CURVE_PROGRAM_ID,
            async (logInfo) => {
                if (this.processedSignatures.has(logInfo.signature + '_lock')) return;

                const hasLockEvent = logInfo.logs.some(log =>
                    log.includes('FIRST BUY DETECTED - Locking')
                );

                if (hasLockEvent && !logInfo.err) {
                    console.log(`\n🔒 FIRST BUYER LOCK DETECTED!`);
                    console.log(`   Signature: ${logInfo.signature}`);

                    this.processedSignatures.add(logInfo.signature + '_lock');

                    const tokenMint = await this.extractTokenMintFromLogs(logInfo.signature);

                    if (tokenMint) {
                        const [bondingCurve] = PublicKey.findProgramAddressSync(
                            [Buffer.from("bonding_curve"), tokenMint.toBuffer()],
                            CONFIG.BONDING_CURVE_PROGRAM_ID
                        );

                        this.addTokenToMonitoring(tokenMint, bondingCurve);
                    }
                }
            },
            'confirmed'
        );

        console.log(`✅ First buyer lock listener active`);

        // Start unlock monitoring interval
        this.unlockMonitoringInterval = setInterval(async () => {
            await this.monitorAllLockedTokens();
        }, CONFIG.UNLOCK_CHECK_INTERVAL);

        console.log(`✅ Unlock monitoring active`);
        console.log(`   Check interval: ${CONFIG.UNLOCK_CHECK_INTERVAL / 60000} minutes\n`);

        // Heartbeat
        setInterval(() => {
            console.log(`💓 Heartbeat - ${new Date().toISOString()}`);
            console.log(`   Processed migrations: ${this.processedSignatures.size}`);
            console.log(`   Monitoring locks: ${this.lockedTokens.size}`);
        }, 60000);

        console.log('💤 Service running - waiting for events...\n');
    }

    stop() {
        if (this.migrationSubscriptionId) {
            this.connection.removeOnLogsListener(this.migrationSubscriptionId);
            this.migrationSubscriptionId = null;
        }

        if (this.lockEventSubscriptionId) {
            this.connection.removeOnLogsListener(this.lockEventSubscriptionId);
            this.lockEventSubscriptionId = null;
        }

        if (this.unlockMonitoringInterval) {
            clearInterval(this.unlockMonitoringInterval);
            this.unlockMonitoringInterval = null;
        }

        this.isRunning = false;
        console.log('🛑 Service stopped');
    }
}
// Main execution
async function main() {
    try {
        const service = new UnifiedMigrationUnlockService();
        await service.start();
        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n\n📴 Shutting down gracefully...');
            service.stop();
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            console.log('\n\n📴 Shutting down gracefully...');
            service.stop();
            process.exit(0);
        });

    } catch (error) {
        console.error('💥 Failed to start service:', error);
        process.exit(1);
    }
}

main();
