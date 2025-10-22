import { VersionedTransaction, PublicKey, Transaction } from '@solana/web3.js';
import { createBurnInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const NOOT_MINT = '2yYb8aAdpMu4u29ow1RZdimauccmkKc4hyhoMnbCjBLV';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = '50'; // 0.5% slippage

export async function swapAndBurnNoot(connection, keypair, amountLamports) {
  try {
    console.log('\n🔥 Starting NOOT buy & burn...');
    console.log(`   Platform fee to burn: ${amountLamports / 1e9} SOL`);

    // 1. Get quote from Jupiter API
    console.log('📊 Getting swap quote...');
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${NOOT_MINT}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`
    );

    if (!quoteResponse.ok) {
      throw new Error(`Quote API error: ${quoteResponse.status}`);
    }

    const quote = await quoteResponse.json();
    
    console.log('   Quote received:');
    console.log(`   Input: ${quote.inAmount / 1e9} SOL`);
    console.log(`   Expected output: ${quote.outAmount / 1e6} NOOT`);
    console.log(`   Price impact: ${quote.priceImpactPct}%`);

    // 2. Get swap transaction from Jupiter API
    console.log('🔄 Getting swap transaction...');
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
      })
    });

    if (!swapResponse.ok) {
      throw new Error(`Swap API error: ${swapResponse.status}`);
    }

    const { swapTransaction } = await swapResponse.json();

    // 3. Sign and send swap transaction
    console.log('🔐 Executing swap transaction...');
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([keypair]);

    const swapTxid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 2
    });

    console.log('⏳ Confirming swap...');
    await connection.confirmTransaction(swapTxid, 'confirmed');
    console.log(`✅ Swap successful: https://solscan.io/tx/${swapTxid}`);

    // 4. Wait for token account update
    console.log('⏳ Waiting for token account update...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Get NOOT token account and check balance
    const nootMint = new PublicKey(NOOT_MINT);
    const tokenAccount = await getAssociatedTokenAddress(
      nootMint,
      keypair.publicKey
    );

    const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
    const nootAmount = tokenBalance.value.amount;
    
    console.log(`💰 NOOT acquired: ${parseFloat(nootAmount) / 1e6} NOOT`);

    if (nootAmount === '0') {
      throw new Error('No NOOT tokens received from swap');
    }

    // 6. Create and send burn transaction
    console.log('🔥 Creating burn transaction...');
    
    const burnInstruction = createBurnInstruction(
      tokenAccount,
      nootMint,
      keypair.publicKey,
      BigInt(nootAmount),
      [],
      TOKEN_PROGRAM_ID
    );

    const burnTransaction = new Transaction().add(burnInstruction);
    const { blockhash } = await connection.getLatestBlockhash();
    burnTransaction.recentBlockhash = blockhash;
    burnTransaction.feePayer = keypair.publicKey;

    console.log('🔐 Executing burn transaction...');
    burnTransaction.sign(keypair);

    const burnTxid = await connection.sendRawTransaction(burnTransaction.serialize(), {
      skipPreflight: false,
      maxRetries: 2
    });

    console.log('⏳ Confirming burn...');
    await connection.confirmTransaction(burnTxid, 'confirmed');
    console.log(`✅ Burn successful: https://solscan.io/tx/${burnTxid}`);
    console.log(`💰 Burned ${parseFloat(nootAmount) / 1e6} NOOT tokens`);

    return { 
      success: true, 
      swapTxid,
      burnTxid,
      burnedAmount: nootAmount,
      burnedAmountFormatted: parseFloat(nootAmount) / 1e6
    };

  } catch (error) {
    console.error('❌ Swap and burn failed:', error.message);
    return { 
      success: false, 
      error: error.message 
    };
  }
}