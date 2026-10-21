// Side-by-side product comparison: integrity rules (pure) + page flows.
import { describe, it, expect, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { analyse, score, csvCell, toCsv, hostAllowed, safeHref, isComparable } from '../lib/compare.js';
import { renderApp, fakeApi, overviewFixture, WS_TEAM, WS_PERSONAL, wsPath } from './helpers.jsx';

const W = wsPath();
const now = new Date().toISOString();
function mon(id, current, over = {}) {
  return {
    id, name: `Product ${id}`, kind: 'product', sourceType: 'web_page', integrationId: 'i1', source: { url: `https://shop-${id}.example.com/p/${id}` },
    health: 'VERIFIED', healthReason: null, current: current === null ? null : { present: true, title: `Title ${id}`, price: 100, listPrice: null, currency: 'INR', discountPct: null, availability: 'IN_STOCK', seller: null, identifiers: {}, ...current },
    currentIsFresh: true, lastSuccessAt: now, status: 'active', version: 1, ...over,
  };
}

afterEach(() => { delete window.confirm; });

describe('comparison rules (no invented or misleading results)', () => {
  it('marks the lowest price best only among fresh, verified, same-currency values', () => {
    const a = mon('a', { price: 900 }); const b = mon('b', { price: 1200 });
    const stale = mon('c', { price: 10 }, { currentIsFresh: false });
    const unverified = mon('d', { price: 5 }, { health: 'UNVERIFIED' });
    const r = analyse([a, b, stale, unverified]);
    expect(r.best.price).toEqual(['a']);
    expect(isComparable(stale)).toBe(false);
    expect(isComparable(unverified)).toBe(false);
  });

  it('never compares prices in different currencies', () => {
    const r = analyse([mon('a', { price: 10, currency: 'USD' }), mon('b', { price: 900, currency: 'INR' })]);
    expect(r.mixedCurrency).toBe(true);
    expect(r.best.price).toBeUndefined();
    expect(r.values.price).toEqual({});
  });

  it('a missing price is not 0 and gets no mark', () => {
    const r = analyse([mon('a', { price: null }), mon('b', { price: 50 })]);
    expect(r.best.price).toBeUndefined();
    expect(r.values.price).toEqual({ b: 50 });
  });

  it('needs two comparable values before declaring a winner', () => {
    expect(analyse([mon('a', { price: 1 })]).best.price).toBeUndefined();
  });

  it('scores are weighted arithmetic and report criteria a product could not be scored on', () => {
    const a = mon('a', { price: 100, availability: 'IN_STOCK' });
    const b = mon('b', { price: 200, availability: 'OUT_OF_STOCK' });
    const s = score([a, b], { price: 1, availability: 1, discount: 0 });
    expect(s.scores.a.score).toBe(100);
    expect(s.scores.b.score).toBe(0);
    const c = mon('c', { price: null, availability: 'IN_STOCK' });
    const s2 = score([a, c], { price: 3, availability: 1, discount: 0 });
    expect(s2.scores.c.missing).toContain('price');
  });

  it('unverified or stale data is never scored, so it cannot outrank verified data', () => {
    const verified = mon('v', { price: 200, availability: 'LIMITED' });
    const cheaper = mon('w', { price: 100, availability: 'IN_STOCK' });
    const unverified = mon('u', { price: null, availability: 'IN_STOCK' }, { health: 'UNVERIFIED' });
    const stale = mon('s', { price: 1, availability: 'IN_STOCK' }, { currentIsFresh: false });
    const s = score([verified, cheaper, unverified, stale], { price: 3, availability: 2, discount: 1 });
    expect(s.scores.u).toMatchObject({ score: null, unverified: true });
    expect(s.scores.s).toMatchObject({ score: null, unverified: true });
    expect(s.scores.w.score).toBe(100);
  });

  it('all criteria off → nothing is scored', () => {
    const s = score([mon('a', {}), mon('b', {})], { price: 0, availability: 0, discount: 0 });
    expect(s.criteria).toEqual([]);
    expect(s.scores.a.score).toBeNull();
  });

  it('CSV export neutralises formulas and states provenance', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    const csv = toCsv([mon('a', { title: '@evil' }), mon('b', { price: null })], score([mon('a', {}), mon('b', {})], { price: 1, availability: 0, discount: 0 }));
    expect(csv).toContain(`"'@evil"`);
    expect(csv).toContain('"not published"');
    expect(csv).toContain('Source URL');
    expect(csv).toContain('Values read from structured data');
  });

  it('host allowlist and link safety', () => {
    expect(hostAllowed({ config: { allowedHosts: ['*.example.com'] } }, 'shop.example.com')).toBe(true);
    expect(hostAllowed({ config: { allowedHosts: ['*.example.com'] } }, 'example.com')).toBe(true);
    expect(hostAllowed({ config: { allowedHosts: ['a.example.com'] } }, 'b.example.com')).toBe(false);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://x.example.com/p')).toBe('https://x.example.com/p');
  });
});

const routes = (extra = [], monitors = [mon('a', { price: 900, discountPct: 10 }), mon('b', { price: 1200 })]) => [
  ...extra,
  ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
  ['GET', /\/overview$/, overviewFixture()],
  ['GET', /\/agents$/, []],
  ['GET', new RegExp(`^${W}/monitoring/monitors\\?kind=product`), monitors],
  ['GET', new RegExp(`^${W}/monitoring/monitors/([a-z0-9-]+)$`), (m) => ({ ...monitors.find((x) => x.id === m[1]), observations: [{ id: 'o1', method: 'json_ld', status: 'VERIFIED' }], changes: [{ id: 'c1', changeType: 'price_decrease', oldValue: 1000, newValue: 900, detectedAt: now }], history: [] })],
  ['GET', new RegExp(`^${W}/integrations$`), [{ id: 'i1', provider: 'web_page', name: 'Web pages', status: 'connected', version: 2, config: { allowedHosts: ['*.example.com'], defaultCurrency: null, maxResponseKb: 2048 } }]],
];

describe('Compare page', () => {
  it('shows two products side by side with evidence, best marks and a score', async () => {
    renderApp({ api: fakeApi(routes()), path: '/compare' });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Title a')).toBeInTheDocument();
    expect(within(table).getByText('Title b')).toBeInTheDocument();
    expect(within(table).getAllByText('Best').length).toBeGreaterThan(0);
    expect(within(table).getByRole('link', { name: 'shop-a.example.com' })).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(await within(table).findAllByText('JSON-LD')).toHaveLength(2);
    expect(within(table).getAllByText('Not published').length).toBeGreaterThan(0);
    expect(screen.getByText('Weighted score')).toBeInTheDocument();
    expect((await screen.findAllByText(/Price decrease/)).length).toBeGreaterThan(0);
  });

  it('warns and does not compare when currencies differ', async () => {
    renderApp({ api: fakeApi(routes([], [mon('a', { price: 10, currency: 'USD' }), mon('b', { price: 900, currency: 'INR' })])), path: '/compare' });
    expect(await screen.findByText('Different currencies')).toBeInTheDocument();
  });

  it('empty workspace explains what to add', async () => {
    renderApp({ api: fakeApi(routes([], [])), path: '/compare' });
    expect(await screen.findByText('No products to compare yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add your first product' })).toBeInTheDocument();
  });

  it('a disabled module is reported, not faked', async () => {
    const api = fakeApi([
      ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
      ['GET', /\/integrations$/, []],
    ]);
    renderApp({ api, path: '/compare' });
    expect(await screen.findByText('Product intelligence is not enabled on this server')).toBeInTheDocument();
  });

  it('adding a product on a new host requires explicit permission, extends the allowlist, creates the monitor and reads it', async () => {
    const api = fakeApi(routes([
      ['PATCH', new RegExp(`^${W}/integrations/i1$`), (m, opts) => ({ id: 'i1', provider: 'web_page', status: 'connected', version: 3, config: opts.body.config })],
      ['POST', new RegExp(`^${W}/monitoring/monitors$`), { ...mon('n', null), id: 'n', name: 'Vendor X', health: 'PENDING' }],
      ['POST', new RegExp(`^${W}/monitoring/monitors/n/check$`), { monitor: { ...mon('n', {}), health: 'VERIFIED' }, changes: [] }],
    ]));
    renderApp({ api, path: '/compare' });
    fireEvent.click(await screen.findByRole('button', { name: /Add product/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vendor X' } });
    fireEvent.change(screen.getByLabelText('Product page address'), { target: { value: 'https://vendor-x.test/item/1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and read' }));
    expect(await screen.findByText('Confirm that Nexus may read public pages on vendor-x.test.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add and read' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/monitors/n/check'))).toBe(true));
    const patch = api.calls.find((c) => c.method === 'PATCH');
    expect(patch.body).toEqual({ version: 2, config: { allowedHosts: ['*.example.com', 'vendor-x.test'], defaultCurrency: null, maxResponseKb: 2048 } });
    const create = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/monitoring/monitors'));
    expect(create.body).toEqual({ name: 'Vendor X', kind: 'product', sourceType: 'web_page', integrationId: 'i1', source: { url: 'https://vendor-x.test/item/1' } });
    const check = api.calls.find((c) => c.path.endsWith('/check'));
    expect(check.headers['Idempotency-Key']).toMatch(/^nexus-/);
  });

  it('a host already on the allowlist needs no new permission', async () => {
    const api = fakeApi(routes([
      ['POST', new RegExp(`^${W}/monitoring/monitors$`), { ...mon('n', null), id: 'n', name: 'Vendor Y' }],
      ['POST', new RegExp(`^${W}/monitoring/monitors/n/check$`), { monitor: mon('n', {}) }],
    ]));
    renderApp({ api, path: '/compare' });
    fireEvent.click(await screen.findByRole('button', { name: /Add product/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vendor Y' } });
    fireEvent.change(screen.getByLabelText('Product page address'), { target: { value: 'https://shop.example.com/p/9' } });
    expect(screen.getByText(/is already allowed by/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add and read' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/monitors/n/check'))).toBe(true));
    expect(api.calls.some((c) => c.method === 'PATCH' || (c.method === 'POST' && c.path.endsWith('/integrations')))).toBe(false);
  });

  it('members can compare but cannot add, read or remove (and integrations are not requested)', async () => {
    const api = fakeApi(routes([], undefined).map((r) => (String(r[1]) === String(/^\/api\/workspaces$/) ? ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, { ...WS_TEAM, role: 'member' }]] : r)));
    renderApp({ api, path: '/compare' });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /Add product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read now' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith('/integrations'))).toBe(false);
  });
});
