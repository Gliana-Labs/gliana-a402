import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the model run, ledger, and schema deps so we test the route's own logic
// (challenge shape / guards / verify+settle orchestration), not Workers AI.
vi.mock('../lib/ai.ts', () => ({
  runModel: vi.fn(async () => ({ output: { ok: true }, actualUnits: 1 })),
  publicErrorDetail: (e: unknown) => String(e),
}));
vi.mock('../lib/ledger.ts', () => ({ logUsage: vi.fn(async () => {}) }));
// Partial mock: discovery.ts's exampleFor() reads the real patchedSchema, so
// only the pre-charge guards are stubbed.
vi.mock('../lib/schema.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schema.ts')>()),
  missingRequired: vi.fn(async () => [] as string[]),
  unreachableFileUrl: vi.fn(async () => null),
}));

import { CATALOG, isDisabled, priceForRequest } from '@gliana-ai/shared';
import { buildA402App, a402Paths, resolve } from './a402.ts';
import { TOOL_PRICES } from './tools.ts';

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const USDC = '31566704';
const PAYTO = 'GLIANAPAYTOADDRESSFORTESTSONLYAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BUYER = 'BUYERADDRESSFORTESTSONLYBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const env = { ALGORAND_PAYTO: PAYTO } as never;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const app = buildA402App();

const model = CATALOG.find((m) => !isDisabled(m))!;
const id = model.id;
const micro = priceForRequest(id, {}).micro;

function accepted(over: Partial<{ network: string; payTo: string; asset: string; amount: string }> = {}) {
  return {
    scheme: 'exact',
    network: over.network ?? MAINNET,
    asset: over.asset ?? USDC,
    amount: over.amount ?? String(micro),
    payTo: over.payTo ?? PAYTO,
    maxTimeoutSeconds: 300,
    extra: {},
  };
}

function paymentHeader(over: Parameters<typeof accepted>[0] = {}) {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepted: accepted(over),
      // The signed Algorand transaction group; opaque to us, decoded by the
      // facilitator. Contents are irrelevant to this rail's own logic.
      payload: { paymentGroup: ['c2lnbmVkLXR4bg=='], paymentIndex: 1 },
    }),
  );
}

function req(path: string, method = 'POST', headers: Record<string, string> = {}, body: unknown = {}) {
  return app.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
}

/** verify → isValid, settle → success, unless overridden. */
function stubFacilitator(over: { verify?: unknown; settle?: unknown } = {}) {
  const mock = vi.fn(async (url: string, _init?: RequestInit) =>
    new Response(
      JSON.stringify(
        url.endsWith('/verify')
          ? (over.verify ?? { isValid: true, payer: BUYER })
          : (over.settle ?? { success: true, transaction: 'TXID123', payer: BUYER }),
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => vi.unstubAllGlobals());

describe('a402 challenge', () => {
  it('402s with an Algorand USDC quote when unpaid', async () => {
    const res = await req(`/a402/${id}`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, never>;
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({ scheme: 'exact', network: MAINNET, asset: USDC, payTo: PAYTO, amount: String(micro) });
  });

  it('prices USDC 1:1 with micro-USD (both 6-decimal)', async () => {
    const name = 'gas-price';
    const res = await req(`/a402/tools/${name}`);
    const body = (await res.json()) as { accepts: { amount: string }[] };
    expect(body.accepts[0].amount).toBe(String(TOOL_PRICES[name].priceMicro));
  });

  it('carries the challenge in the payment-required header too', async () => {
    const res = await req(`/a402/${id}`);
    const header = res.headers.get('payment-required');
    expect(header).toBeTruthy();
    expect(JSON.parse(atob(header!))).toMatchObject({ x402Version: 2 });
  });

  it('tags the resource for the x402 Global Challenge leaderboard', async () => {
    const res = await req(`/a402/${id}`);
    const body = (await res.json()) as { accepts: { extra: { tag: string } }[]; resource: { tags: string[] } };
    expect(body.accepts[0].extra.tag).toBe('x402-global-challenge');
    expect(body.resource.tags).toContain('x402-global-challenge');
  });

  it('answers the unpaid GET probe with a challenge, not a 200', async () => {
    const res = await req(`/a402/${id}`, 'GET');
    expect(res.status).toBe(402); // x402scan/crawlers discover the resource this way
  });

  it('404s an id that is not on the catalog', async () => {
    const res = await req('/a402/definitely-not-a-model');
    expect(res.status).toBe(404);
    // An unknown id must never reach env.AI.run — it would price at the
    // 'other' fallback while running an arbitrary model on our account.
    expect((await res.json() as { error: string }).error).toBe('unknown_resource');
  });

  it('503s a disabled model instead of charging for a doomed call', async () => {
    const off = CATALOG.find((m) => isDisabled(m));
    if (!off) return; // nothing disabled right now
    const res = await req(`/a402/${off.id}`);
    expect(res.status).toBe(503); // exists but killed — not the same as unknown
    expect((await res.json() as { error: string }).error).toBe('model_disabled');
  });

  it('never advertises a resource priced at zero', async () => {
    // A 0-USDC quote is a free call with a receipt attached.
    for (const p of a402Paths(env)) {
      const t = resolve(env, p);
      expect(typeof t === 'string' ? 0 : t.micro).toBeGreaterThan(0);
    }
  });
});

describe('a402 payment guards', () => {
  it('402s a payment quoted on the wrong network', async () => {
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader({ network: 'eip155:8453' }) });
    expect(res.status).toBe(402);
    expect((await res.json() as { error: string }).error).toBe('wrong_network');
  });

  it('402s a payment addressed to someone else', async () => {
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader({ payTo: 'SOMEONEELSE' }) });
    expect((await res.json() as { error: string }).error).toBe('wrong_recipient');
  });

  it('402s a payment in the wrong asset', async () => {
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader({ asset: '99999' }) });
    expect((await res.json() as { error: string }).error).toBe('wrong_asset');
  });
});

describe('a402 verify → run → settle', () => {
  it('holds the facilitator to OUR requirements, not the buyer’s claim', async () => {
    // The buyer under-quotes; we still send our own amount to /verify, which is
    // what makes relaying safe (the facilitator decodes the group against it).
    const mock = stubFacilitator();
    await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader({ amount: '1' }) });
    const sent = JSON.parse(String(mock.mock.calls[0][1]?.body ?? '{}'));
    expect(sent.paymentRequirements.amount).toBe(String(micro));
    expect(sent.paymentRequirements.payTo).toBe(PAYTO);
  });

  it('overwrites the relayed resource info so the listing is ours', async () => {
    const mock = stubFacilitator();
    await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader() });
    const sent = JSON.parse(String(mock.mock.calls[0][1]?.body ?? '{}'));
    expect(sent.paymentPayload.resource.description).toContain('GlianaAI');
  });

  it('relays the bazaar discovery extension, or the facilitator cannot list us', async () => {
    // Every resource in the facilitator's index carries a discoveryInfo built
    // from this. Sending it only on the challenge left us uncatalogued after a
    // real MainNet settle.
    const mock = stubFacilitator();
    await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader() });
    const sent = JSON.parse(String(mock.mock.calls[0][1]?.body ?? '{}'));
    expect(sent.paymentPayload.extensions?.bazaar?.info?.input?.method).toBe('POST');
    expect(sent.paymentPayload.extensions?.bazaar?.info?.output).toBeTruthy();
  });

  it('runs and settles a valid payment, returning a receipt', async () => {
    const mock = stubFacilitator();
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader() });
    expect(res.status).toBe(200);
    expect((await res.json() as { output: unknown }).output).toEqual({ ok: true });
    expect(res.headers.get('x-payment-response')).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(2); // verify + settle
  });

  it('never settles when verification fails', async () => {
    const mock = stubFacilitator({ verify: { isValid: false, invalidReason: 'invalid_exact_avm_amount_mismatch' } });
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader() });
    expect(res.status).toBe(402);
    expect(mock).toHaveBeenCalledTimes(1); // no settle
  });

  it('withholds the output when settlement fails', async () => {
    stubFacilitator({ settle: { success: false, errorReason: 'invalid_exact_avm_settlement_failed' } });
    const res = await req(`/a402/${id}`, 'POST', { 'x-payment': paymentHeader() });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; output?: unknown };
    expect(body.error).toBe('settlement_failed');
    expect(body.output).toBeUndefined();
  });
});
