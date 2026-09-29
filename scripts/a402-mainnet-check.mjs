#!/usr/bin/env node
/**
 * Check that a MainNet address is ready to be ALGORAND_PAYTO.
 *
 *   node scripts/a402-mainnet-check.mjs <ALGORAND_ADDRESS>
 *
 * Read-only — takes an address, never a key. Run it before setting the var and
 * again after, because the failure it catches is silent: an account that has
 * not opted into the ASA cannot receive it, so every settle fails on-chain
 * while the gateway looks perfectly healthy.
 */
import { AlgorandClient } from '@algorandfoundation/algokit-utils/algorand-client';

const USDC_MAINNET_ASA = 31566704n;
const address = process.argv[2];
if (!address) {
  console.error('usage: node scripts/a402-mainnet-check.mjs <ALGORAND_ADDRESS>');
  process.exit(1);
}

const algorand = AlgorandClient.mainNet();
let info;
try {
  info = await algorand.account.getInformation(address);
} catch {
  console.error(`NOT READY — ${address} does not exist on MainNet yet.`);
  console.error('Send it some ALGO first (~0.3 covers the account minimum, the');
  console.error('ASA opt-in minimum, and fees).');
  process.exit(1);
}

const algo = Number(info.balance.microAlgo) / 1e6;
const usdc = (info.assets ?? []).find((a) => BigInt(a.assetId ?? a['asset-id']) === USDC_MAINNET_ASA);

console.log(`address  ${address}`);
console.log(`ALGO     ${algo}`);
console.log(`USDC     ${usdc ? `opted in, balance ${Number(usdc.amount) / 1e6}` : 'NOT OPTED IN'}`);

const problems = [];
// 0.2 = 0.1 base account minimum + 0.1 held per ASA. Below this the account
// cannot even complete the opt-in, let alone receive.
if (algo < 0.2) problems.push(`ALGO balance ${algo} is below the 0.2 needed to hold an ASA.`);
if (!usdc) problems.push(`Not opted into USDC (ASA ${USDC_MAINNET_ASA}) — every settle would fail.`);

if (problems.length) {
  console.error('\nNOT READY:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nREADY — safe to set as ALGORAND_PAYTO.');
