import { Hono } from 'hono';
import type { Context } from 'hono';
import { CATALOG, CATEGORY_LABELS, getCatalogModel, isDisabled, runIdOf, priceForRequest } from '@gliana-ai/shared';
import type { Env } from '../env.ts';
import { classifyInferenceError, runModel, publicErrorDetail } from '../lib/ai.ts';
import { missingRequired, unreachableFileUrl, badObjectField } from '../lib/schema.ts';
import { logUsage } from '../lib/ledger.ts';
import { internalPaidHeaders } from '../lib/internal.ts';
import { tools, TOOL_PRICES, TOOL_GUIDANCE, TOOL_EXAMPLES, toolOnX402 } from './tools.ts';
import { recipes, RECIPE_NAMES, RECIPE_EXAMPLES, recipePriceMicroFor } from './recipes.ts';
import { exampleFor } from './discovery.ts';
import { completeChat, CHAT_STATIC_INPUT } from './chat.ts';
import { PITCH_SHORT } from '../lib/pitch.ts';

// a402 — x402 on Algorand (AVM), settled through the GoPlausible facilitator.
//
// WHY HAND-ROLLED instead of `@x402/avm` + the payment middleware: the AVM scheme
// package depends on @algorandfoundation/algokit-utils (algosdk), which is the
// exact class of dependency that put cold-start CPU at 60M ms in 2026-07 (the
// Stellar/Monad rails stay commented out in lib/mpp.ts for the same reason). As
// the SELLER we never build or sign an Algorand transaction — we quote a price,
// relay the buyer's signed group to /verify + /settle, and read the result. That
// needs zero Algorand code, so this rail costs ~0 bundle bytes.
//
// SAFETY: the GoPlausible facilitator decodes the buyer's transaction group and
// checks it against the `paymentRequirements` WE send — receiver, amount and
// asset all have their own invalid reasons (`invalid_exact_avm_receiver_mismatch`,
// `_amount_mismatch`, `_asset_mismatch`). So building the requirements ourselves
// from our own price and payTo is what makes relaying safe. This is the opposite
// of the b402 facilitator, which verifies only signature/nonce/balance and left
// us to enforce recipient and amount by hand (see routes/b402.ts).
//
// Gasless: the facilitator's fee payer funds the group, so the buyer needs USDC
// but no ALGO for fees.

// CAIP-2 network ids. NOTE the reference is the FULL 44-char genesis hash — the
// @x402/avm constants truncate it to 32 (CAIP-2's nominal cap) but every live
// resource in the facilitator's own discovery index, and its own GET /supported,
// use the full form. Advertising the truncated one is the Solana-CAIP-2 trap in
// routes/x402.ts wearing a different hat, pointing the other way.
const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
// USDC ASA per network. 6 decimals — identical to our micro-USD unit, so a
// price in micros IS the atomic amount, no conversion (contrast b402's 1e12).
const USDC_ASA: Record<string, string> = { [MAINNET]: '31566704', [TESTNET]: '10458941' };

const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz';
// GoPlausible's AVM fee payer as advertised by GET /supported on 2026-08-08.
// Hardcoded (with an env override) rather than probed: x402.ts shows what a
// facilitator probe on the request path costs us when it blips — an isolate
// that cold-starts during the blip serves a degraded challenge forever.
const DEFAULT_FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

// The x402 Global Challenge leaderboard finds entrants by this tag in `extra`.
// Algorand Foundation challenge; submissions Sept 2026, judged on real October
// on-chain volume. Harmless to any other client — it is opaque metadata.
const CHALLENGE_TAG = 'x402-global-challenge';

const X402_VERSION = 2;

/** True when an Algorand payTo address is configured (enables /a402/*). */
export function a402Enabled(env: Env): boolean {
  return Boolean(env.ALGORAND_PAYTO);
}

type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};
type ResourceInfo = { url: string; description?: string; mimeType?: string; tags?: string[] };
type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

/** Decode the buyer's base64 `X-PAYMENT` header into a v2 payload, or null. */
function readPayment(header: string | undefined): PaymentPayload | null {
  if (!header) return null;
  try {
    const p = JSON.parse(atob(header)) as PaymentPayload;
    // `payload` carries the signed transaction group; `accepted` is the quote
    // the buyer chose. Both must be present for the facilitator to do anything.
    if (!p?.payload || !p?.accepted) return null;
    return p;
  } catch {
    return null;
  }
}

/** Why a path has no paid surface: a disabled model is temporary, not unknown. */
type Miss = 'unknown' | 'disabled';

/** What a caller is buying — used for the challenge and for the listing text. */
type Target =
  | { kind: 'model'; name: string; micro: number; description: string; example: Record<string, unknown> }
  | { kind: 'tool'; name: string; micro: number; description: string; example: Record<string, unknown> }
  | { kind: 'recipe'; name: string; micro: number; description: string; example: Record<string, unknown> };

/**
 * Resolve `/a402/<rest>` to what it sells. Returns null for anything not on the
 * catalog — an unknown id must never reach env.AI.run (it would price at the
 * 'other' fallback while running an arbitrary model on our account).
 */
export function resolve(env: Env, rest: string): Target | Miss {
  if (rest.startsWith('tools/')) {
    const name = rest.slice('tools/'.length);
    // A tool priced at 0 must never get a paid surface: the challenge would
    // quote a 0-USDC transfer, which is a free call with a receipt attached.
    if (!TOOL_PRICES[name] || TOOL_PRICES[name].priceMicro <= 0 || !toolOnX402(env, name)) return 'unknown';
    return {
      kind: 'tool',
      name,
      micro: TOOL_PRICES[name].priceMicro,
      description: `GlianaAI - ${PITCH_SHORT} (100+ models incl. LLM chat), no signup, USDC on Algorand. This resource: tools/${name}.${TOOL_GUIDANCE[name] ? ' ' + TOOL_GUIDANCE[name] : ''} https://ai.glianalabs.com`,
      example: TOOL_EXAMPLES[name] ?? {},
    };
  }
  if (rest.startsWith('recipes/')) {
    const name = rest.slice('recipes/'.length);
    const micro = RECIPE_NAMES.includes(name) ? (recipePriceMicroFor(name) ?? 0) : 0;
    if (micro <= 0) return 'unknown'; // same reason as a 0-priced tool
    return {
      kind: 'recipe',
      name,
      micro,
      description: `GlianaAI - pay-per-call AI (100+ models incl. LLM chat), no signup, USDC on Algorand. This resource: recipes/${name}, a multi-model pipeline (one paid call, image -> video). https://ai.glianalabs.com`,
      example: RECIPE_EXAMPLES[name] ?? {},
    };
  }
  const m = getCatalogModel(rest);
  // Catalog-only: an unknown id must never reach env.AI.run — it would price at
  // the 'other' fallback while running an arbitrary model on our account.
  if (!m) return 'unknown';
  // Disabled models get no paid surface either — a registered-but-broken model
  // is a charge-then-fail waiting to happen (burned USDC, 2026-07-07).
  if (isDisabled(m)) return 'disabled';
  const micro = priceForRequest(m.id, staticInputFor(m)).micro;
  if (micro <= 0) return 'unknown'; // never quote a 0-USDC transfer
  return {
    kind: 'model',
    name: m.id,
    micro,
    description: `GlianaAI - pay-per-call AI: LLM chat (OpenAI-compatible), image, video, music, speech - 100+ models, no signup, USDC on Algorand. This resource: ${m.id} (${CATEGORY_LABELS[m.category]}). https://ai.glianalabs.com`,
    example: exampleFor(runIdOf(m)),
  };
}

/** Static quote input: text models price a default-size chat, others empty. */
const staticInputFor = (m: { tokenTiers?: unknown }): Record<string, unknown> => (m.tokenTiers ? CHAT_STATIC_INPUT : {});

function net(env: Env): string {
  return env.ALGORAND_NETWORK || MAINNET;
}

/** Build the requirements WE will hold the facilitator to. */
function requirementsFor(env: Env, micro: number): PaymentRequirements {
  const network = net(env);
  const asset = env.ALGORAND_USDC_ASA || USDC_ASA[network];
  return {
    scheme: 'exact',
    network,
    asset,
    // USDC is 6-decimal and so is micro-USD: the price IS the atomic amount.
    amount: String(micro),
    payTo: env.ALGORAND_PAYTO!,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USDC',
      decimals: 6,
      asset,
      tag: CHALLENGE_TAG,
      feePayer: env.ALGORAND_FEE_PAYER || DEFAULT_FEE_PAYER,
    },
  };
}

function resourceInfo(url: string, t: Target): ResourceInfo {
  return { url, description: t.description, mimeType: 'application/json', tags: [CHALLENGE_TAG] };
}

/**
 * Bazaar discovery extension, declared by hand. The full @x402 extension 500s on
 * Workers (its Ajv meta-schema compile uses new Function(), which workerd bans),
 * so this mirrors the shape without the validator.
 *
 * This is what the facilitator catalogs as a resource's `discoveryInfo`, so it
 * has to travel on the payment payload we relay, not just on the challenge —
 * every listed resource in its index carries one. Sent on BOTH so a client that
 * echoes the challenge and one that does not produce the same listing.
 */
function bazaarExtension(t: Target) {
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: t.example },
        output: { type: 'json', example: { [t.kind]: t.name, url: 'https://api.glianalabs.com/v1/media/<id>' } },
      },
      // The `schema` sibling is NOT decoration: the facilitator validates `info`
      // against it before cataloguing, and a declaration without one is dropped
      // silently — payments settle, USDC arrives, and the resource simply never
      // appears in /discovery/resources. We shipped `info` alone from 2026-08-08
      // and had 0 of 2393 indexed resources on 2026-09-29 despite real settles.
      // Mirrors createBodyDiscoveryExtension() in @x402/extensions, which we
      // cannot call here (its Ajv compile uses new Function(), banned on workerd).
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: { properties: {} },
            },
            required: ['type', 'method'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: { type: 'object' } },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  };
}

/** The v2 402 body. Also emitted base64 in the `payment-required` header. */
function challengeBody(env: Env, url: string, t: Target) {
  return {
    x402Version: X402_VERSION,
    error: 'Payment required',
    resource: resourceInfo(url, t),
    accepts: [requirementsFor(env, t.micro)],
    extensions: bazaarExtension(t),
  };
}

/**
 * base64 of a JSON value. NOT plain btoa: btoa is Latin-1 only and throws
 * `InvalidCharacterError` on the first non-ASCII byte — and our own tool
 * guidance is full of em dashes and `≤`, so `btoa(JSON.stringify(...))` 500s
 * the challenge for those resources instead of returning it. Encode to UTF-8
 * bytes first (the @x402 SDK does the same on the /x402 rail).
 */
function b64json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function facilitate(env: Env, kind: 'verify' | 'settle', body: unknown) {
  const base = env.ALGORAND_FACILITATOR_URL || DEFAULT_FACILITATOR;
  const res = await fetch(`${base}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Build the a402 sub-app. One wildcard handler rather than a route per model:
 * nothing here needs the x402 payment middleware's per-route registration, and
 * 160+ registrations is cold-start work we would pay on every isolate.
 */
// No `env` parameter: everything reads `c.env` per request, so the built app is
// safe to cache per isolate even if a var changes between requests.
export function buildA402App() {
  const app = new Hono<{ Bindings: Env }>();
  type Ctx = Context<{ Bindings: Env }>;

  // Both are FREE and land before any pricing or payment, per the catalog-only
  // rule: 404 = never existed, 503 = exists but is currently killed.
  const miss = (c: Ctx, why: Miss) =>
    why === 'disabled'
      ? c.json({ error: 'model_disabled', detail: 'This model is temporarily disabled. See GET /v1/models for what is live.' }, 503)
      : c.json({ error: 'unknown_resource', detail: 'No such paid model, tool or recipe. See GET /v1/models and GET /v1/tools.' }, 404);

  const challenge = (c: Ctx, t: Target) => {
    const body = challengeBody(c.env, c.req.url, t);
    return c.json(body, 402, {
      // v2 dialect: the challenge also rides in this header, which is what
      // @x402 clients and the scanners read. Body stays readable for humans.
      'payment-required': b64json(body),
    });
  };

  // GET/HEAD are the unpaid probe: crawlers and x402scan must get the challenge,
  // not a 200, or the resource never appears in a directory.
  app.on(['GET', 'HEAD'], '/a402/*', (c) => {
    const t = resolve(c.env, c.req.path.slice('/a402/'.length));
    if (typeof t === 'string') return miss(c, t);
    if (c.req.header('x-payment'))
      return c.json({ [t.kind]: t.name, hint: 'POST this URL with a JSON body to run it.' });
    return challenge(c, t);
  });

  app.post('/a402/*', async (c) => {
    const t = resolve(c.env, c.req.path.slice('/a402/'.length));
    if (typeof t === 'string') return miss(c, t);

    const payment = readPayment(c.req.header('x-payment'));
    if (!payment) return challenge(c, t);

    const required = requirementsFor(c.env, t.micro);
    // The facilitator rejects a network/scheme mismatch between payload.accepted
    // and paymentRequirements, so a wrong `accepted` would fail there anyway —
    // catching it here turns an opaque facilitator error into a clear one.
    const a = payment.accepted;
    if (a?.network !== required.network || a?.scheme !== 'exact')
      return c.json({ error: 'wrong_network', detail: `Pay on ${required.network} with scheme "exact".` }, 402);
    if (a.payTo !== required.payTo)
      return c.json({ error: 'wrong_recipient', detail: 'Authorization must pay the advertised payTo.' }, 402);
    if (a.asset !== required.asset)
      return c.json({ error: 'wrong_asset', detail: `Pay in USDC (ASA ${required.asset}).` }, 402);

    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));

    // ── Pre-settlement guards: never settle a call that is going to fail ──
    if (t.kind === 'model') {
      const cm = getCatalogModel(t.name)!;
      const isText = Boolean(cm.tokenTiers);
      if (!isText) {
        const missing = await missingRequired(c.env, runIdOf(cm), body);
        if (missing.length) return c.json({ error: 'missing_input', detail: `Required field(s): ${missing.join(', ')}` }, 400);
        const badObj = await badObjectField(c.env, runIdOf(cm), body);
        if (badObj) return c.json({ error: 'invalid_input', detail: badObj }, 400);
        // HEAD-probe file URLs too. Settlement is still ahead of us here, so
        // this is not a money guard — it turns a dead link (a dead host answers
        // 530, which is why the probe exists) into a clear error instead of an
        // opaque provider 500 after we have already done the work for free.
        const badUrl = await unreachableFileUrl(c.env, runIdOf(cm), body);
        if (badUrl) return c.json({ error: 'file_url_unreachable', detail: badUrl }, 400);
      } else if (!Array.isArray(body.messages) || !body.messages.length) {
        return c.json({ error: 'missing_input', detail: 'Required: { messages: [{role, content}, …], max_tokens? (≤1024 here) }.' }, 400);
      }
      // The advertised price covers a default-size request; reject input whose
      // billable ceiling costs more (60s of video at the 5s price, etc.).
      if (priceForRequest(t.name, body).micro > t.micro)
        return c.json(
          {
            error: 'input_exceeds_quoted_price',
            detail: isText
              ? 'This resource is priced for a default-size chat. Use POST /v1/chat/completions for longer inputs.'
              : 'This resource is priced for a default-size request. Use POST /v1/infer (MPP) for dynamic per-request pricing.',
          },
          400,
        );
    } else if (t.kind === 'recipe' && (recipePriceMicroFor(t.name, body) ?? 0) > t.micro) {
      return c.json(
        { error: 'input_exceeds_quoted_price', detail: `Use POST /v1/recipes/${t.name} (MPP) for dynamic per-request pricing.` },
        400,
      );
    }

    // Relay with OUR requirements — that is what the facilitator decodes the
    // buyer's transaction group against. Overwrite `resource` so the listing
    // the facilitator catalogs is our description, not buyer-supplied text.
    const relayed: PaymentPayload = {
      ...payment,
      x402Version: X402_VERSION,
      resource: resourceInfo(c.req.url, t),
      // Our own discovery info, not the buyer's — this is what the facilitator
      // catalogs, so a payer must not be able to write our listing.
      extensions: bazaarExtension(t),
    };
    const verifyReq = { x402Version: X402_VERSION, paymentPayload: relayed, paymentRequirements: required };

    const verified = await facilitate(c.env, 'verify', verifyReq);
    if (!verified.isValid)
      return c.json(
        { error: 'payment_invalid', detail: String(verified.invalidMessage ?? verified.invalidReason ?? 'verification failed') },
        402,
      );

    // Verified → run, THEN settle. Output is withheld until settlement confirms,
    // so a settle failure never gives the result away for free (b402 pattern).
    let result: { status: number; payload: unknown };
    try {
      result = await run(c, t, body);
    } catch (err) {
      c.executionCtx.waitUntil(
        logUsage(c.env, { modelId: t.name, units: 0, costMicroUsd: 0, payer: null, status: 'error', errorCode: classifyInferenceError(err, `/a402/${t.name}`), endpoint: new URL(c.req.url).pathname }),
      );
      return c.json({ error: 'inference_failed', detail: publicErrorDetail(err) }, 502);
    }
    // A non-2xx from the underlying handler is a failed call: settle nothing.
    if (result.status >= 300) return c.json(result.payload as object, result.status as 400);

    const settled = await facilitate(c.env, 'settle', verifyReq);
    if (!settled.success) {
      c.executionCtx.waitUntil(
        logUsage(c.env, { modelId: t.name, units: 0, costMicroUsd: 0, payer: String(verified.payer ?? '') || null, status: 'error', errorCode: 'settlement_failed', endpoint: new URL(c.req.url).pathname }),
      );
      return c.json({ error: 'settlement_failed', detail: String(settled.errorReason ?? 'settle failed') }, 402);
    }

    c.executionCtx.waitUntil(
      logUsage(c.env, { modelId: t.name, units: 1, costMicroUsd: t.micro, endpoint: new URL(c.req.url).pathname, payer: String(settled.payer ?? verified.payer ?? '') || null, status: 'ok' }),
    );
    const receipt = b64json({
      success: true,
      transaction: settled.transaction,
      network: required.network,
      payer: settled.payer ?? verified.payer,
    });
    return c.json(result.payload as object, 200, { 'x-payment-response': receipt });
  });

  return app;
}

/**
 * Run the resolved target. Tools and recipes re-dispatch INTERNALLY to their
 * existing /v1 handler with the internal-paid marker, so they skip their own MPP
 * charge and there is no double billing.
 */
async function run(
  c: Context<{ Bindings: Env }>,
  t: Target,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  const origin = new URL(c.req.url).origin;
  if (t.kind === 'tool' || t.kind === 'recipe') {
    const path = t.kind === 'tool' ? `/tools/${t.name}` : `/recipes/${t.name}`;
    const ir = new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { ...internalPaidHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const app = t.kind === 'tool' ? tools : recipes;
    const res = await app.fetch(ir, c.env, c.executionCtx);
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  }
  const cm = getCatalogModel(t.name)!;
  if (cm.tokenTiers) {
    const payload = await completeChat(c.env, cm, runIdOf(cm), body.messages as { role: string; content: unknown }[], body, t.micro);
    return { status: 200, payload };
  }
  const { output } = await runModel(c.env, runIdOf(cm), body, origin);
  return { status: 200, payload: { model: t.name, costMicroUsd: t.micro, output } };
}

/** Every /a402 resource path, for the discovery spec and the seeding script. */
export function a402Paths(env: Env): string[] {
  const all = [
    ...CATALOG.map((m) => m.id),
    ...Object.keys(TOOL_PRICES).map((n) => `tools/${n}`),
    ...RECIPE_NAMES.map((n) => `recipes/${n}`),
  ];
  // Derived from resolve() rather than re-listing the rules, so the seeding
  // script can never advertise a path the rail itself refuses to sell.
  return all.filter((p) => typeof resolve(env, p) !== 'string');
}
