# a402 — x402 on Algorand

The Algorand payment rail behind [GlianaAI](https://ai.glianalabs.com): a
pay-per-call AI inference gateway where a caller buys **one model run** with
USDC on Algorand MainNet. No account, no API key, no subscription — an HTTP 402
handshake is the only gate.

Entered in the **Algorand x402 Global Challenge** as a Composite Entry: 47 live
endpoints on one domain, sharing one payTo.

```
POST https://api.glianalabs.com/a402/tools/embed
  → 402 + payment requirements (price, asset, payTo, fee payer)
  → client signs an ASA transfer group
  → we relay to the GoPlausible facilitator: /verify, run, /settle
  → 200 + the result, USDC at payTo
```

## What is here

| Path | What it is | Runnable |
|---|---|---|
| `src/a402.ts` | the rail: challenge, guards, relay, settle | reference source |
| `src/a402.test.ts` | its 17 tests | reference source |
| `scripts/a402-pay.mjs` | a client that pays an `/a402` resource | **yes** |
| `scripts/a402-mainnet-check.mjs` | checks an address can receive the ASA | **yes** |

`src/` is extracted verbatim from the GlianaAI gateway, which is a private
monorepo, so it does not compile on its own — it imports the catalogue, pricing,
schema guards and usage ledger from there. It is published so the rail can be
read and audited, not vendored. The two scripts are standalone and really run.

What each import provides, so nothing is hidden:

- `@gliana-ai/shared` — model catalogue, prices, kill-switch for broken models
- `../env.ts` — bindings; `ALGORAND_PAYTO` is what enables this rail at all
- `../lib/ai.ts` — runs the model
- `../lib/schema.ts` — **pre-charge** input guards
- `../lib/ledger.ts` — usage rows
- `./tools.ts`, `./recipes.ts`, `./chat.ts` — the non-model resources also sold

## Live

47 resources. All prices are exact and quoted in the 402 before anything runs.

```bash
curl -s -X POST https://api.glianalabs.com/a402/tools/embed \
  -H 'content-type: application/json' -d '{"texts":["hello"]}' | jq
```

```
network   algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=   (MainNet)
asset     31566704                                                (USDC)
payTo     SQ2NZ6TVGSGY7MQNEDYK27WX5TEDTV6WDPVIZO77DGKHJGAYV6ZYJUKT5U
feePayer  ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA
tag       x402-global-challenge
```

Pay one for real:

```bash
npm install
AVM_PRIVATE_KEY=<base64 ed25519 key> \
  node scripts/a402-pay.mjs https://api.glianalabs.com/a402/tools/embed '{"texts":["hello"]}'
```

The payer needs USDC and must be opted in to ASA 31566704. It does **not** need
ALGO for fees — the facilitator's fee payer funds the group, which is the point:
an agent can hold one asset and still transact.

## Three things worth reading the code for

**We build the payment requirements, never the buyer.** `requirementsFor()`
constructs amount, asset and payTo from our own price and config, and the relay
overwrites whatever the buyer sent. The facilitator decodes the signed group
against *our* requirements, so a buyer cannot quote themselves a cheaper price or
redirect the payment. (`routes/b402.ts` in the gateway verifies only
signature/nonce/balance and has to enforce recipient and amount by hand — this
rail is the opposite shape.)

**Validate before charging.** A request that cannot succeed is rejected at the
402, not charged and then failed: missing required fields, either-or inputs,
dead file URLs, and inputs whose real price exceeds the quoted one are all
caught pre-charge. Money safety is the invariant the whole gateway is designed
around.

**Run, then settle.** The model runs after `/verify` and before `/settle`, and
the output is withheld until settlement confirms. A settle failure never gives
the result away for free, and a failed model run never takes the money.

## A trap, recorded

The CAIP-2 network id is the **full 44-character genesis hash**. The `@x402/avm`
constants truncate it to 32 (CAIP-2's nominal cap), but every live resource in
the facilitator's index and its own `GET /supported` use the full form.
Advertising the truncated one produces a challenge no client can pay.

The Bazaar discovery declaration needs both `info` **and** a sibling `schema`.
The facilitator validates one against the other before cataloguing, and drops a
declaration without a schema silently — payments still settle and USDC still
arrives, so from the seller's side nothing looks wrong at all, while the resource
never appears in `/discovery/resources`.

## Licence

MIT.
