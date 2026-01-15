import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import fs from 'fs';

const bondingCurveIDL = JSON.parse(fs.readFileSync('./bonding_curve.json'));
const { AnchorProvider, Program, BN } = anchor

console.log(Object.keys(bondingCurveIDL));

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    RPC_URL: "https://solana-mainnet.api.syndica.io/api-key/21P91u6oC24BUjduDPBnPEdmPWWz7fmFp3jtMBY52Mgq5j1CE9sjKbUv1TzPZGan2pKeDg289fHqvdP6UK5cAHhyJmuHSLE2qm",
    WS_URL: "wss://solana-mainnet.api.syndica.io/api-key/21P91u6oC24BUjduDPBnPEdmPWWz7fmFp3jtMBY52Mgq5j1CE9sjKbUv1TzPZGan2pKeDg289fHqvdP6UK5cAHhyJmuHSLE2qm",
    BONDING_CURVE_PROGRAM_ID: new PublicKey("CPMWvEXzNTnrksm1PPXQzp2UUTXWxCKQaw9HhvDdf3nT"),
    ORACLE_PRIVATE_KEY: process.env.MIGRATION_BOT_PRIVATE_KEY, // Base58 encoded private key
    UPDATE_INTERVAL_MS: 30000, // Update every 30 seconds
    BATCH_SIZE: 10, // Process up to 10 tokens per batch
    JUPITER_API_KEY: "60012c1b-4bd1-4e6f-a6a3-eb991ed23e95",
};

// ==========================================
// GLOBAL STATE
// ==========================================
class OracleState {
    constructor() {
        this.trackedTokens = new Map(); // tokenMint -> { holderCount, volumeUsd, lastUpdate }
        this.pendingUpdates = new Set(); // Set of token mints that need updates
        this.solPrice = 186.14; // Default SOL price
        this.isProcessing = false;
    }

    trackToken(mint) {
        if (!this.trackedTokens.has(mint)) {
            this.trackedTokens.set(mint, {
                holderCount: 0,
                volumeUsdCents: 0,
                lastUpdate: 0,
                lastHolderCheck: 0,
                accumulatedVolumeCents: 0, // Volume since last update
            });
            console.log(`📊 Now tracking token: ${mint}`);
        }
    }

    markForUpdate(mint) {
        this.pendingUpdates.add(mint);
    }

    recordTrade(mint, solAmount) {
        this.trackToken(mint);
        const data = this.trackedTokens.get(mint);
        const volumeUsdCents = Math.floor(solAmount * this.solPrice * 100);
        data.accumulatedVolumeCents += volumeUsdCents;
        this.markForUpdate(mint);
    }
}

const state = new OracleState();

// ==========================================
// PRICE FETCHING
// ==========================================
async function fetchSolPrice() {
    try {
        const response = await fetch(
            'https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
            {
                headers: {
                    'x-api-key': CONFIG.JUPITER_API_KEY,
                },
            }
        );
        const data = await response.json();
        const price = data['So11111111111111111111111111111111111111112']?.usdPrice;
        
        if (price && price > 0) {
            state.solPrice = price;
            console.log(`💵 Updated SOL price: $${price.toFixed(2)}`);
        }
    } catch (error) {
        console.error('❌ Error fetching SOL price:', error.message);
    }
}

// ==========================================
// HOLDER COUNT FETCHING
// ==========================================
async function fetchHolderCount(connection, mint) {
    try {
        const tokenAccounts = await connection.getProgramAccounts(
            TOKEN_2022_PROGRAM_ID,
            {
                filters: [
                    { dataSize: 182 }, // Token account size
                    {
                        memcmp: {
                            offset: 0,
                            bytes: mint,
                        },
                    },
                ],
            }
        );

        // Filter for accounts with non-zero balance
        let holderCount = 0;
        for (const account of tokenAccounts) {
            const amount = account.account.data.readBigUInt64LE(64);
            if (amount > 0n) {
                holderCount++;
            }
        }

        return holderCount;
    } catch (error) {
        console.error(`❌ Error fetching holder count for ${mint}:`, error.message);
        return 0;
    }
}

// ==========================================
// TRANSACTION LISTENER
// ==========================================
async function setupTransactionListener(connection, program) {
    console.log('👂 Setting up transaction listener...');
    
    // Listen for logs from the bonding curve program
    connection.onLogs(
        CONFIG.BONDING_CURVE_PROGRAM_ID,
        async (logs) => {
            try {
                const signature = logs.signature;
                const txLogs = logs.logs;

                // Check if this is a buy or sell transaction
                const isBuy = txLogs.some(log => log.includes('Buy:'));
                const isSell = txLogs.some(log => log.includes('Sell:'));

                if (!isBuy && !isSell) return;

                // Fetch full transaction to get accounts and amounts
                const tx = await connection.getTransaction(signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0,
                });

                if (!tx || !tx.meta) return;

                // Extract token mint from transaction accounts
                const accountKeys = tx.transaction.message.getAccountKeys();
                let tokenMint = null;
                
                // The token mint is typically the 6th account in the trade instruction
                if (accountKeys.length > 5) {
                    tokenMint = accountKeys.get(5).toString();
                }

                if (!tokenMint) return;

                // Parse amount from logs
                let solAmount = 0;
                for (const log of txLogs) {
                    if (isBuy && log.includes('Buy:')) {
                        // Format: "Buy: X SOL for Y tokens"
                        const match = log.match(/Buy: (\d+) SOL/);
                        if (match) {
                            solAmount = parseInt(match[1]) / 1e9;
                        }
                    } else if (isSell && log.includes('Sell:')) {
                        // Format: "Sell: Y tokens for X SOL"
                        const match = log.match(/for (\d+) SOL/);
                        if (match) {
                            solAmount = parseInt(match[1]) / 1e9;
                        }
                    }
                }

                if (solAmount > 0) {
                    console.log(`\n💰 ${isBuy ? 'BUY' : 'SELL'} detected for ${tokenMint.slice(0, 8)}...`);
                    console.log(`   Amount: ${solAmount.toFixed(4)} SOL`);
                    
                    state.recordTrade(tokenMint, solAmount);
                }

            } catch (error) {
                console.error('❌ Error processing transaction:', error.message);
            }
        },
        'confirmed'
    );

    console.log('✅ Transaction listener active');
}

// ==========================================
// BATCH UPDATE PROCESSOR
// ==========================================
async function processBatchUpdates(connection, program, oracleKeypair) {
    if (state.isProcessing) {
        console.log('⏳ Already processing updates, skipping...');
        return;
    }

    if (state.pendingUpdates.size === 0) {
        return;
    }

    state.isProcessing = true;
    console.log(`\n🔄 Processing ${state.pendingUpdates.size} pending updates...`);

    const updatesToProcess = Array.from(state.pendingUpdates).slice(0, CONFIG.BATCH_SIZE);
    state.pendingUpdates.clear();

    for (const mintStr of updatesToProcess) {
        try {
            const mint = new PublicKey(mintStr);
            const tokenData = state.trackedTokens.get(mintStr);

            if (!tokenData || tokenData.accumulatedVolumeCents === 0) {
                continue;
            }

            // Fetch holder count (but not on every update to save RPC calls)
            const now = Date.now();
            if (now - tokenData.lastHolderCheck > 60000) { // Check holders every 60 seconds
                const holderCount = await fetchHolderCount(connection, mintStr);
                tokenData.holderCount = holderCount;
                tokenData.lastHolderCheck = now;
            }

            // Derive bonding curve PDA
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding_curve"), mint.toBuffer()],
                CONFIG.BONDING_CURVE_PROGRAM_ID
            );

            // Check if bonding curve exists and has active lock
            const curveData = await program.account.bondingCurve.fetch(bondingCurve);
            
            if (!curveData.firstBuyerLockActive) {
                console.log(`⏭️  Skipping ${mintStr.slice(0, 8)}... (no active lock)`);
                tokenData.accumulatedVolumeCents = 0; // Reset
                continue;
            }

            // Prepare update transaction
            const currentTimestamp = Math.floor(Date.now() / 1000);
            
            console.log(`📤 Updating ${mintStr.slice(0, 8)}...`);
            console.log(`   Holders: ${tokenData.holderCount}`);
            console.log(`   Volume: $${(tokenData.accumulatedVolumeCents / 100).toFixed(2)}`);

            const tx = await program.methods
                .batchUpdateData(
                    new BN(tokenData.holderCount),
                    new BN(currentTimestamp),
                    new BN(tokenData.accumulatedVolumeCents),
                    new BN(currentTimestamp)
                )
                .accounts({
                    bondingCurve,
                    oracleAuthority: oracleKeypair.publicKey,
                })
                .signers([oracleKeypair])
                .rpc();

            console.log(`✅ Updated successfully: ${tx.slice(0, 8)}...`);
            
            // Reset accumulated volume after successful update
            tokenData.accumulatedVolumeCents = 0;
            tokenData.lastUpdate = currentTimestamp;

            // Check unlock conditions after update
            try {
                await program.methods
                    .checkUnlockConditions()
                    .accounts({
                        bondingCurve,
                    })
                    .rpc();

                // Fetch updated data to check if unlockable
                const updatedData = await program.account.bondingCurve.fetch(bondingCurve);
                
                if (updatedData.unlockable) {
                    console.log(`🎉 TOKEN ${mintStr.slice(0, 8)}... IS NOW UNLOCKABLE!`);
                    console.log(`   Holders: ${updatedData.currentHolderCount.toString()}/${updatedData.holderThreshold.toString()}`);
                    console.log(`   Volume: $${(parseInt(updatedData.totalVolumeUsd.toString()) / 100).toFixed(2)}/$${(parseInt(updatedData.volumeThreshold.toString()) / 100).toFixed(2)}`);
                }
            } catch (error) {
                // Non-critical error
                console.warn(`⚠️  Could not check unlock conditions: ${error.message}`);
            }

        } catch (error) {
            console.error(`❌ Error updating ${mintStr.slice(0, 8)}...:`, error.message);
        }

        // Small delay between updates to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    state.isProcessing = false;
    console.log('✅ Batch update complete\n');
}

// ==========================================
// INITIALIZATION
// ==========================================
async function initialize() {
    console.log('🚀 Starting Bonding Curve Oracle Service...\n');

    // Validate environment
    if (!CONFIG.ORACLE_PRIVATE_KEY) {
        throw new Error('ORACLE_PRIVATE_KEY environment variable is required');
    }

    // Initialize connection
    const connection = new Connection(CONFIG.RPC_URL, {
        commitment: 'confirmed',
        wsEndpoint: CONFIG.WS_URL,
    });

    // Initialize oracle keypair
    const oracleKeypair = Keypair.fromSecretKey(
        bs58.decode(CONFIG.ORACLE_PRIVATE_KEY)
    );

    console.log(`🔑 Oracle Authority: ${oracleKeypair.publicKey.toString()}`);

    // Initialize program
    const provider = new AnchorProvider(
        connection,
        { publicKey: oracleKeypair.publicKey },
        { commitment: 'confirmed' }
    );
    const program = new Program(bondingCurveIDL, provider);

    // Fetch initial SOL price
    await fetchSolPrice();

    // Setup transaction listener
    await setupTransactionListener(connection, program);

    // Setup periodic price updates
    setInterval(() => fetchSolPrice(), 60000); // Update price every minute

    // Setup periodic batch updates
    setInterval(
        () => processBatchUpdates(connection, program, oracleKeypair),
        CONFIG.UPDATE_INTERVAL_MS
    );

    console.log(`⏰ Batch updates scheduled every ${CONFIG.UPDATE_INTERVAL_MS / 1000}s`);
    console.log('\n✅ Oracle service is now running...\n');
}

// ==========================================
// ERROR HANDLING & STARTUP
// ==========================================
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down oracle service...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down oracle service...');
    process.exit(0);
});

// Start the service
initialize().catch((error) => {
    console.error('❌ Failed to initialize oracle service:', error);
    process.exit(1);
});