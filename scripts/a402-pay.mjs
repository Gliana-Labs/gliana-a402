#!/usr/bin/env node
/**
 * Pay an /a402 resource — the client side of the Algorand rail, for testing it
 * end to end before MainNet. Run from a terminal, never from the Worker: this
 * pulls in algosdk (via @x402/avm), which is exactly the dependency the rail
 * itself is hand-rolled to keep OUT of the bundle.
 *
 *   AVM_PRIVATE_KEY=<base64 ed25519 key> \
 *     node scripts/a402-pay.mjs https://api.glianalabs.com/a402/tools/gas-price '{"chain":"base"}'
 *
 * The key signs an ASA transfer to whatever the challenge advertises, so point
 * this at TestNet first. Two accounts have to be ready before it can work:
 *   - the PAYER (this key) holds TestNet/MainNet USDC and is opted in to the ASA
 *   - the PAYEE (ALGORAND_PAYTO on the gateway) is opted in to the ASA too,
 *     or every settle fails with an opt-in error and no money moves
 *
 * Fees are covered by the facilitator's fee payer, so the payer needs USDC but
 * no ALGO beyond the account minimum balance.
 */
// The client scheme lives on its own subpath and is ALSO called ExactAvmScheme —
// the root export of that name is the server one, which cannot sign.
import { ExactAvmScheme as ExactAvmClient } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

const [, , url, bodyArg] = process.argv;
if (!url) {
  console.error('usage: node scripts/a402-pay.mjs <a402 url> [json body]');
  process.exit(1);
}
const key = process.env.AVM_PRIVATE_KEY;
if (!key) {
  console.error('AVM_PRIVATE_KEY (base64 ed25519 private key) is required.');
  process.exit(1);
}
const body = bodyArg ?? '{}';

const signer = toClientAvmSigner(key);
const client = new ExactAvmClient(signer);
console.log(`payer   ${signer.address}`);

// 1. Unpaid request → 402 with the challenge. The v2 challenge rides in the
//    `payment-required` header (base64 JSON); the body carries it too.
const probe = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
if (probe.status !== 402) {
  console.error(`expected 402, got ${probe.status}: ${(await probe.text()).slice(0, 400)}`);
  process.exit(1);
}
const header = probe.headers.get('payment-required');
const challenge = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : await probe.json();
const accepted = challenge.accepts.find((a) => String(a.network).startsWith('algorand:'));
if (!accepted) {
  console.error('no Algorand quote in the challenge:', JSON.stringify(challenge.accepts, null, 2));
  process.exit(1);
}
console.log(`quote   ${accepted.amount} of ASA ${accepted.asset} → ${accepted.payTo}`);
console.log(`network ${accepted.network}`);

// 2. Build and sign the transaction group. The SDK accepts both the full
//    44-char genesis hash we advertise and its own truncated 32-char constant.
const { payload } = await client.createPaymentPayload(challenge.x402Version ?? 2, accepted);

// 3. Retry with the payment attached. `accepted` echoes back the quote we chose;
//    the gateway relays it with ITS OWN requirements, so a tampered copy here
//    fails at the facilitator rather than silently underpaying.
const paid = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-payment': Buffer.from(
      JSON.stringify({ x402Version: challenge.x402Version ?? 2, resource: challenge.resource, accepted, payload }),
    ).toString('base64'),
  },
  body,
});

const receipt = paid.headers.get('x-payment-response');
console.log(`status  ${paid.status}`);
if (receipt) console.log('receipt', JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')));
console.log(JSON.stringify(await paid.json().catch(() => ({})), null, 2).slice(0, 2000));
process.exit(paid.ok ? 0 : 1);
