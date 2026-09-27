/**
 * Layer 1 — multi-tenant security tests.
 *
 * Plain Node + assert (same convention as
 * backend-routing/__tests__/regression.test.js — no test framework).
 *
 * Exercises the REAL middleware/auth.js, middleware/sanitizer.js,
 * middleware/workspaceContext.js, routes/workspaces.js and
 * services/workspaceService.js over HTTP. Only Firebase token
 * verification is replaced (tokens look like `tok|uid|email|verified`).
 *
 * Storage backend:
 *   default                  in-memory store (__tests__/support/memoryWorkspaceStore.js)
 *   WORKSPACE_TEST_STORE=supabase  the production Supabase store against
 *                            SUPABASE_URL / SUPABASE_KEY (a disposable
 *                            local Postgres+PostgREST with the migration
 *                            applied — NEVER point this at production).
 *
 * Run: node __tests__/workspaces.security.test.js
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STORE_MODE = process.env.WORKSPACE_TEST_STORE === 'supabase' ? 'supabase' : 'memory';

// ---- fake Firebase Admin (token verification only) ------------------
function fakeModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}
fakeModule(require.resolve(path.join(ROOT, 'config', 'firebaseAdmin.js')), () => ({
  auth: () => ({
    async verifyIdToken(token) {
      const [kind, uid, email, verified] = String(token).split('|');
      if (kind !== 'tok' || !uid) throw new Error('invalid token');
      return { uid, email: email || undefined, email_verified: verified === '1' };
    },
  }),
}));
// Quiet winston during tests.
fakeModule(require.resolve(path.join(ROOT, 'services', 'logger.js')), {
  info() {}, warn() {}, error() {}, debug() {},
});

const express = require('express');
const authenticateFirebaseUser = require(path.join(ROOT, 'middleware', 'auth.js'));
const sanitizeInput = require(path.join(ROOT, 'middleware', 'sanitizer.js'));
const { createWorkspacesRouter } = require(path.join(ROOT, 'routes', 'workspaces.js'));
const { createWorkspaceService, hashToken, INVITE_TTL_MS } = require(path.join(ROOT, 'services', 'workspaceService.js'));
const { workspaceContext, requireWorkspaceRole } = require(path.join(ROOT, 'middleware', 'workspaceContext.js'));
const { createMemoryWorkspaceStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceStore.js'));
const { createSupabaseWorkspaceStore } = require(path.join(ROOT, 'services', 'workspaceStore.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.stack || err.message}`);
    failed++;
  }
}

// ---- app under test ---------------------------------------------------
let clockOffsetMs = 0;
const store = STORE_MODE === 'supabase' ? createSupabaseWorkspaceStore() : createMemoryWorkspaceStore();
const service = createWorkspaceService(store, {
  now: () => new Date(Date.now() + clockOffsetMs),
  requireVerifiedEmail: true,
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser);
  app.use('/api/workspaces', createWorkspacesRouter({ service }));
  // Stand-in for an existing userId-scoped route, to prove the pre-existing
  // uid-mismatch guard in middleware/auth.js is unchanged.
  app.get('/api/chat/chats/:userId', (req, res) => res.json({ ok: true }));
  // Example of a future tenant-scoped route using the Layer 1 middleware.
  app.get('/api/tenant-probe', workspaceContext(service), requireWorkspaceRole('admin'),
    (req, res) => res.json({ workspaceId: req.workspace.id, role: req.workspace.role }));
  return app;
}

// Simulates the existing dev bypass in auth.js (no req.user set).
function buildAppWithoutAuth() {
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', createWorkspacesRouter({ service }));
  return app;
}

async function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Unique per run so the supabase mode can reuse a DB between runs.
const RUN = crypto.randomBytes(4).toString('hex');
const U = {
  alice: { uid: `alice_${RUN}`, email: `alice_${RUN}@example.com` },
  bob: { uid: `bob_${RUN}`, email: `bob_${RUN}@example.com` },
  carol: { uid: `carol_${RUN}`, email: `carol_${RUN}@example.com` },
  dave: { uid: `dave_${RUN}`, email: `dave_${RUN}@example.com` },
  eve: { uid: `eve_${RUN}`, email: `eve_${RUN}@example.com` },
  mallory: { uid: `mallory_${RUN}`, email: `mallory_${RUN}@example.com` },
};
const tok = (u, verified = true, email = u.email) => `tok|${u.uid}|${email}|${verified ? '1' : '0'}`;

function client(base) {
  return async function call(method, url, { as, token, body, headers = {} } = {}) {
    const h = { 'content-type': 'application/json', ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    else if (as) h.authorization = `Bearer ${tok(as)}`;
    const res = await fetch(base + url, { method, headers: h, body: body && method !== 'GET' && method !== 'HEAD' ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };
}

async function run() {
  console.log(`# workspace security tests — store: ${STORE_MODE}`);
  const srv = await listen(buildApp());
  const call = client(`http://127.0.0.1:${srv.address().port}`);
  const srvNoAuth = await listen(buildAppWithoutAuth());
  const callNoAuth = client(`http://127.0.0.1:${srvNoAuth.address().port}`);

  // shared state built up through the tests
  let alicePersonal;
  let bobPersonal;
  let teamA; // alice's team workspace
  let teamB; // bob's team workspace

  // ------------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------------
  await test('auth: no token → 401', async () => {
    const r = await call('GET', '/api/workspaces');
    assert.strictEqual(r.status, 401);
  });
  await test('auth: invalid token → 401', async () => {
    const r = await call('GET', '/api/workspaces', { token: 'garbage' });
    assert.strictEqual(r.status, 401);
  });
  await test('auth: dev-bypass request without verified user is still rejected (401)', async () => {
    for (const [m, u] of [['GET', '/api/workspaces'], ['POST', '/api/workspaces'], ['GET', '/api/workspaces/current'],
      ['POST', '/api/workspaces/invitations/accept'], ['GET', `/api/workspaces/${crypto.randomUUID()}`]]) {
      const r = await callNoAuth(m, u, { body: { name: 'x', token: 'y'.repeat(43) } });
      assert.strictEqual(r.status, 401, `${m} ${u} → ${r.status}`);
    }
  });

  // ------------------------------------------------------------------
  // Personal workspace for existing users
  // ------------------------------------------------------------------
  await test('personal: first call creates exactly one personal workspace with role owner', async () => {
    const r = await call('GET', '/api/workspaces', { as: U.alice });
    assert.strictEqual(r.status, 200);
    const personal = r.body.data.filter((w) => w.is_personal);
    assert.strictEqual(personal.length, 1);
    assert.strictEqual(personal[0].role, 'owner');
    assert.strictEqual(personal[0].owner_id, U.alice.uid);
    alicePersonal = personal[0];
  });
  await test('personal: idempotent across calls (same id)', async () => {
    const r = await call('GET', '/api/workspaces', { as: U.alice });
    const personal = r.body.data.filter((w) => w.is_personal);
    assert.strictEqual(personal.length, 1);
    assert.strictEqual(personal[0].id, alicePersonal.id);
  });
  await test('personal: 10 concurrent first requests still produce ONE personal workspace', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call('GET', '/api/workspaces', { as: U.bob })));
    results.forEach((r) => assert.strictEqual(r.status, 200));
    const ids = new Set(results.map((r) => r.body.data.find((w) => w.is_personal).id));
    assert.strictEqual(ids.size, 1);
    bobPersonal = results[0].body.data.find((w) => w.is_personal);
    const again = await call('GET', '/api/workspaces', { as: U.bob });
    assert.strictEqual(again.body.data.filter((w) => w.is_personal).length, 1);
  });
  await test('personal: /current with no header resolves to the personal workspace', async () => {
    const r = await call('GET', '/api/workspaces/current', { as: U.alice });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.id, alicePersonal.id);
  });
  await test('personal: cannot be deleted', async () => {
    const r = await call('DELETE', `/api/workspaces/${alicePersonal.id}`, { as: U.alice });
    assert.strictEqual(r.status, 400);
  });
  await test('personal: cannot invite others into it', async () => {
    const r = await call('POST', `/api/workspaces/${alicePersonal.id}/invitations`, { as: U.alice, body: { email: U.bob.email } });
    assert.strictEqual(r.status, 400);
  });

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------
  await test('create: team workspace, creator is owner', async () => {
    const r = await call('POST', '/api/workspaces', { as: U.alice, body: { name: '  Acme GST  ' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.name, 'Acme GST');
    assert.strictEqual(r.body.data.role, 'owner');
    assert.strictEqual(r.body.data.is_personal, false);
    teamA = r.body.data;
    const b = await call('POST', '/api/workspaces', { as: U.bob, body: { name: 'Bob Logistics' } });
    teamB = b.body.data;
  });
  await test('create: invalid names rejected (400)', async () => {
    for (const name of [undefined, '', '   ', 'x'.repeat(101), 42]) {
      const r = await call('POST', '/api/workspaces', { as: U.alice, body: { name } });
      assert.strictEqual(r.status, 400, `name=${JSON.stringify(name)}`);
    }
  });
  await test('create: client cannot force is_personal/owner_id', async () => {
    const r = await call('POST', '/api/workspaces', { as: U.eve, body: { name: 'Sneaky', owner_id: U.alice.uid, is_personal: true } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.owner_id, U.eve.uid);
    assert.strictEqual(r.body.data.is_personal, false);
  });
  await test('create: HTML in name is neutralised by the existing sanitizer', async () => {
    const r = await call('POST', '/api/workspaces', { as: U.eve, body: { name: '<script>alert(1)</script>' } });
    assert.strictEqual(r.status, 201);
    assert.ok(!r.body.data.name.includes('<script>'));
  });

  // ------------------------------------------------------------------
  // Cross-tenant isolation (bob/mallory vs alice's workspaces)
  // ------------------------------------------------------------------
  await test('isolation: list only returns own memberships', async () => {
    const r = await call('GET', '/api/workspaces', { as: U.bob });
    const ids = r.body.data.map((w) => w.id);
    assert.ok(!ids.includes(teamA.id));
    assert.ok(!ids.includes(alicePersonal.id));
    assert.ok(ids.includes(teamB.id));
  });
  await test('isolation: non-member gets 404 on every workspace-scoped endpoint', async () => {
    const invId = crypto.randomUUID();
    for (const target of [teamA.id, alicePersonal.id]) {
      const cases = [
        ['GET', `/api/workspaces/${target}`],
        ['PATCH', `/api/workspaces/${target}`, { name: 'pwned' }],
        ['DELETE', `/api/workspaces/${target}`],
        ['GET', `/api/workspaces/${target}/members`],
        ['PATCH', `/api/workspaces/${target}/members/${U.alice.uid}`, { role: 'member' }],
        ['DELETE', `/api/workspaces/${target}/members/${U.alice.uid}`],
        ['GET', `/api/workspaces/${target}/invitations`],
        ['POST', `/api/workspaces/${target}/invitations`, { email: U.mallory.email }],
        ['DELETE', `/api/workspaces/${target}/invitations/${invId}`],
      ];
      for (const [m, u, body] of cases) {
        const r = await call(m, u, { as: U.mallory, body });
        assert.strictEqual(r.status, 404, `${m} ${u} → ${r.status}`);
      }
    }
    const still = await call('GET', `/api/workspaces/${teamA.id}`, { as: U.alice });
    assert.strictEqual(still.body.data.name, 'Acme GST');
  });
  await test('isolation: X-Workspace-Id header for a foreign workspace → 404', async () => {
    const r = await call('GET', '/api/workspaces/current', { as: U.bob, headers: { 'x-workspace-id': teamA.id } });
    assert.strictEqual(r.status, 404);
    const p = await call('GET', '/api/tenant-probe', { as: U.bob, headers: { 'x-workspace-id': teamA.id } });
    assert.strictEqual(p.status, 404);
  });
  await test('isolation: X-Workspace-Id header for own workspace works via the reusable middleware', async () => {
    const p = await call('GET', '/api/tenant-probe', { as: U.bob, headers: { 'x-workspace-id': teamB.id } });
    assert.strictEqual(p.status, 200);
    assert.deepStrictEqual(p.body, { workspaceId: teamB.id, role: 'owner' });
  });
  await test('isolation: malformed workspace ids → 404 (no DB error leak)', async () => {
    for (const bad of ['not-a-uuid', "1' or '1'='1", '00000000-0000-0000-0000-00000000000g']) {
      const r = await call('GET', `/api/workspaces/${encodeURIComponent(bad)}`, { as: U.alice });
      assert.strictEqual(r.status, 404, bad);
      const h = await call('GET', '/api/workspaces/current', { as: U.alice, headers: { 'x-workspace-id': bad } });
      assert.strictEqual(h.status, 404, `header ${bad}`);
    }
  });
  await test('isolation: unknown uuid → same 404 as foreign workspace (no enumeration)', async () => {
    const a = await call('GET', `/api/workspaces/${crypto.randomUUID()}`, { as: U.bob });
    const b = await call('GET', `/api/workspaces/${teamA.id}`, { as: U.bob });
    assert.strictEqual(a.status, 404);
    assert.deepStrictEqual(a.body, b.body);
  });

  let inviteBobToA;
  await test('isolation: owner of workspace B cannot revoke an invitation of workspace A through B', async () => {
    const created = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.bob.email, role: 'member' } });
    assert.strictEqual(created.status, 201);
    inviteBobToA = created.body.data;
    const r = await call('DELETE', `/api/workspaces/${teamB.id}/invitations/${inviteBobToA.invitation.id}`, { as: U.bob });
    assert.strictEqual(r.status, 404);
    const list = await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice });
    assert.strictEqual(list.body.data.find((i) => i.id === inviteBobToA.invitation.id).status, 'pending');
  });
  await test('isolation: owner of B cannot change/remove a member of A through B', async () => {
    const r1 = await call('PATCH', `/api/workspaces/${teamB.id}/members/${U.alice.uid}`, { as: U.bob, body: { role: 'member' } });
    assert.strictEqual(r1.status, 404);
    const r2 = await call('DELETE', `/api/workspaces/${teamB.id}/members/${U.alice.uid}`, { as: U.bob });
    assert.strictEqual(r2.status, 404);
    const m = await call('GET', `/api/workspaces/${teamA.id}/members`, { as: U.alice });
    assert.strictEqual(m.body.data.find((x) => x.user_id === U.alice.uid).role, 'owner');
  });
  await test('isolation: existing userId-mismatch guard in auth.js is unchanged', async () => {
    const own = await call('GET', `/api/chat/chats/${U.alice.uid}`, { as: U.alice });
    assert.strictEqual(own.status, 200);
    const other = await call('GET', `/api/chat/chats/${U.bob.uid}`, { as: U.alice });
    assert.strictEqual(other.status, 403);
  });

  // ------------------------------------------------------------------
  // Invitations
  // ------------------------------------------------------------------
  await test('invite: raw token is returned once, only its SHA-256 is stored, list never exposes it', async () => {
    const { token, invitation } = inviteBobToA;
    assert.ok(typeof token === 'string' && token.length >= 40);
    assert.ok(!('token_hash' in invitation));
    const list = await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice });
    const serialized = JSON.stringify(list.body);
    assert.ok(!serialized.includes(token));
    assert.ok(!serialized.includes('token_hash'));
    if (STORE_MODE === 'memory') {
      const row = store._dump().invitations.find((i) => i.id === invitation.id);
      assert.strictEqual(row.token_hash, hashToken(token));
      assert.ok(!JSON.stringify(store._dump()).includes(token));
    }
  });
  await test('invite: duplicate pending invite for same email → 409', async () => {
    const r = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.bob.email.toUpperCase() } });
    assert.strictEqual(r.status, 409);
  });
  await test('invite: invalid email / role=owner rejected (400)', async () => {
    for (const body of [{ email: 'nope' }, { email: '' }, { email: U.carol.email, role: 'owner' }, { email: U.carol.email, role: 'superadmin' }]) {
      const r = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
  });
  await test('invite: accepting with a different account email → 403, invite stays pending', async () => {
    const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.mallory, body: { token: inviteBobToA.token } });
    assert.strictEqual(r.status, 403);
    const list = await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice });
    assert.strictEqual(list.body.data.find((i) => i.id === inviteBobToA.invitation.id).status, 'pending');
  });
  await test('invite: unverified email cannot accept (403)', async () => {
    const r = await call('POST', '/api/workspaces/invitations/accept', { token: tok(U.bob, false), body: { token: inviteBobToA.token } });
    assert.strictEqual(r.status, 403);
  });
  await test('invite: garbage / unknown token → 404', async () => {
    for (const t of [undefined, '', 'short', crypto.randomBytes(32).toString('base64url')]) {
      const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.bob, body: { token: t } });
      assert.strictEqual(r.status, 404, String(t));
    }
  });
  await test('invite: correct user accepts → becomes member with invited role', async () => {
    const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.bob, body: { token: inviteBobToA.token } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.workspace.id, teamA.id);
    assert.strictEqual(r.body.data.workspace.role, 'member');
    const ws = await call('GET', `/api/workspaces/${teamA.id}`, { as: U.bob });
    assert.strictEqual(ws.status, 200);
    assert.strictEqual(ws.body.data.role, 'member');
  });
  await test('invite: token is single-use (replay → 404)', async () => {
    const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.bob, body: { token: inviteBobToA.token } });
    assert.strictEqual(r.status, 404);
  });
  await test('invite: concurrent double-accept of one token → exactly one success', async () => {
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.carol.email, role: 'admin' } });
    assert.strictEqual(inv.status, 201);
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      call('POST', '/api/workspaces/invitations/accept', { as: U.carol, body: { token: inv.body.data.token } })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    const members = await call('GET', `/api/workspaces/${teamA.id}/members`, { as: U.alice });
    assert.strictEqual(members.body.data.filter((m) => m.user_id === U.carol.uid).length, 1);
    assert.strictEqual(members.body.data.find((m) => m.user_id === U.carol.uid).role, 'admin');
  });
  await test('invite: expired token → 404 and list shows expired', async () => {
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.dave.email } });
    clockOffsetMs = INVITE_TTL_MS + 60_000;
    try {
      const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.dave, body: { token: inv.body.data.token } });
      assert.strictEqual(r.status, 404);
      const list = await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice });
      assert.strictEqual(list.body.data.find((i) => i.id === inv.body.data.invitation.id).status, 'expired');
      // an expired pending invite does not block a fresh one
      const again = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.dave.email } });
      assert.strictEqual(again.status, 201);
    } finally {
      clockOffsetMs = 0;
    }
  });
  await test('invite: revoked token → 404', async () => {
    const list = await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice });
    const pendingDave = list.body.data.find((i) => i.email === U.dave.email && i.status === 'pending');
    const rv = await call('DELETE', `/api/workspaces/${teamA.id}/invitations/${pendingDave.id}`, { as: U.alice });
    assert.strictEqual(rv.status, 200);
    assert.strictEqual(rv.body.data.status, 'revoked');
    const rv2 = await call('DELETE', `/api/workspaces/${teamA.id}/invitations/${pendingDave.id}`, { as: U.alice });
    assert.strictEqual(rv2.status, 409);
  });
  await test('invite: already a member → 409', async () => {
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.bob.email } });
    assert.strictEqual(inv.status, 201);
    const r = await call('POST', '/api/workspaces/invitations/accept', { as: U.bob, body: { token: inv.body.data.token } });
    assert.strictEqual(r.status, 409);
    await call('DELETE', `/api/workspaces/${teamA.id}/invitations/${inv.body.data.invitation.id}`, { as: U.alice });
  });

  // teamA now: alice=owner, bob=member, carol=admin
  // ------------------------------------------------------------------
  // Role boundaries
  // ------------------------------------------------------------------
  await test('roles: member can read workspace + members but nothing more', async () => {
    assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}`, { as: U.bob })).status, 200);
    assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}/members`, { as: U.bob })).status, 200);
    const denied = [
      ['PATCH', `/api/workspaces/${teamA.id}`, { name: 'x' }],
      ['DELETE', `/api/workspaces/${teamA.id}`],
      ['GET', `/api/workspaces/${teamA.id}/invitations`],
      ['POST', `/api/workspaces/${teamA.id}/invitations`, { email: U.eve.email }],
      ['PATCH', `/api/workspaces/${teamA.id}/members/${U.carol.uid}`, { role: 'member' }],
      ['DELETE', `/api/workspaces/${teamA.id}/members/${U.carol.uid}`],
      ['DELETE', `/api/workspaces/${teamA.id}/members/${U.alice.uid}`],
    ];
    for (const [m, u, body] of denied) {
      const r = await call(m, u, { as: U.bob, body });
      assert.strictEqual(r.status, 403, `${m} ${u} → ${r.status}`);
    }
    const p = await call('GET', '/api/tenant-probe', { as: U.bob, headers: { 'x-workspace-id': teamA.id } });
    assert.strictEqual(p.status, 403);
  });
  await test('roles: member cannot self-promote', async () => {
    const r = await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.bob, body: { role: 'admin' } });
    assert.strictEqual(r.status, 403);
  });
  await test('roles: admin can rename and invite members', async () => {
    const r = await call('PATCH', `/api/workspaces/${teamA.id}`, { as: U.carol, body: { name: 'Acme GST Filing' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.name, 'Acme GST Filing');
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.carol, body: { email: U.eve.email, role: 'member' } });
    assert.strictEqual(inv.status, 201);
    const ok = await call('POST', '/api/workspaces/invitations/accept', { as: U.eve, body: { token: inv.body.data.token } });
    assert.strictEqual(ok.status, 200);
  });
  await test('roles: admin cannot invite an admin, change roles, remove owner, or delete workspace', async () => {
    const cases = [
      ['POST', `/api/workspaces/${teamA.id}/invitations`, { email: U.dave.email, role: 'admin' }],
      ['PATCH', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { role: 'admin' }],
      ['PATCH', `/api/workspaces/${teamA.id}/members/${U.carol.uid}`, { role: 'admin' }],
      ['DELETE', `/api/workspaces/${teamA.id}/members/${U.alice.uid}`],
      ['DELETE', `/api/workspaces/${teamA.id}`],
    ];
    for (const [m, u, body] of cases) {
      const r = await call(m, u, { as: U.carol, body });
      assert.strictEqual(r.status, 403, `${m} ${u} → ${r.status}`);
    }
  });
  await test('roles: admin can remove a member, but not another admin', async () => {
    const r = await call('DELETE', `/api/workspaces/${teamA.id}/members/${U.eve.uid}`, { as: U.carol });
    assert.strictEqual(r.status, 200);
    const gone = await call('GET', `/api/workspaces/${teamA.id}`, { as: U.eve });
    assert.strictEqual(gone.status, 404);
    // promote bob to admin (owner), then carol (admin) must not be able to remove him
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.alice, body: { role: 'admin' } })).status, 200);
    const r2 = await call('DELETE', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.carol });
    assert.strictEqual(r2.status, 403);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.alice, body: { role: 'member' } })).status, 200);
  });
  await test('roles: owner cannot be demoted, removed, or leave; invalid role → 400; unknown member → 404', async () => {
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.alice.uid}`, { as: U.alice, body: { role: 'member' } })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/workspaces/${teamA.id}/members/${U.alice.uid}`, { as: U.alice })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.alice, body: { role: 'owner' } })).status, 400);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/nobody_${RUN}`, { as: U.alice, body: { role: 'admin' } })).status, 404);
  });
  await test('roles: role change takes effect on the very next request (no stale cache)', async () => {
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.carol.uid}`, { as: U.alice, body: { role: 'member' } })).status, 200);
    assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.carol })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${teamA.id}/members/${U.carol.uid}`, { as: U.alice, body: { role: 'admin' } })).status, 200);
    assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}/invitations`, { as: U.carol })).status, 200);
  });
  await test('roles: member can leave; afterwards has no access', async () => {
    const r = await call('DELETE', `/api/workspaces/${teamA.id}/members/${U.bob.uid}`, { as: U.bob });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.left, true);
    assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}`, { as: U.bob })).status, 404);
  });
  await test('roles: removed-then-reinvited user regains only the invited role', async () => {
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.bob.email, role: 'member' } });
    const ok = await call('POST', '/api/workspaces/invitations/accept', { as: U.bob, body: { token: inv.body.data.token } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.data.workspace.role, 'member');
  });

  // ------------------------------------------------------------------
  // Deletion
  // ------------------------------------------------------------------
  await test('delete: owner deletes team workspace → everyone loses access, pending invites die', async () => {
    const inv = await call('POST', `/api/workspaces/${teamA.id}/invitations`, { as: U.alice, body: { email: U.dave.email } });
    assert.strictEqual(inv.status, 201);
    const r = await call('DELETE', `/api/workspaces/${teamA.id}`, { as: U.alice });
    assert.strictEqual(r.status, 200);
    for (const u of [U.alice, U.bob, U.carol]) {
      assert.strictEqual((await call('GET', `/api/workspaces/${teamA.id}`, { as: u })).status, 404);
    }
    const acc = await call('POST', '/api/workspaces/invitations/accept', { as: U.dave, body: { token: inv.body.data.token } });
    assert.strictEqual(acc.status, 404);
    const list = await call('GET', '/api/workspaces', { as: U.bob });
    assert.ok(!list.body.data.some((w) => w.id === teamA.id));
    assert.ok(list.body.data.some((w) => w.id === bobPersonal.id));
  });

  srv.close();
  srvNoAuth.close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${STORE_MODE})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
