/**
 * P-SEC-9 (public-launch hardening): per-device revocation for the
 * shared-secret voice-device auth path (NEXUS_VOICE_DEVICE_TOKEN).
 *
 * Covers both independently-duplicated resolvers --
 * backend-routing/resolveUserId.js (commandRoute.js's main POST
 * handler) and security-engine/callerIdentity.js (permissions.js,
 * emergencyStop.js, the goal status/answer routes) -- since a fix in
 * only one would leave the other still trusting a revoked device.
 *
 * NEXUS_VOICE_DEVICE_REVOKED_IDS (like NEXUS_VOICE_DEVICE_TOKEN itself)
 * is read once at module load, so each scenario below runs in its own
 * fresh child process (same pattern as the PERMISSIONS_ENFORCED boot
 * probe in voiceSurface.security.test.js) rather than juggling
 * require.cache resets.
 *
 * Plain Node + assert. Run: node __tests__/voiceDeviceRevocation.security.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}\n  ${err.message}`);
  }
}

// Runs `-e <script>` in a fresh Node process with the given env, and
// the two resolver modules already required as `resolveUserId` /
// `callerIdentity`. The script prints a single JSON line to stdout.
function probe(env, script) {
  const full = `
    const resolveUserId = require('./backend-routing/resolveUserId.js');
    const callerIdentity = require('./security-engine/callerIdentity.js');
    ${script}
  `;
  const res = spawnSync(process.execPath, ['-e', full], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SUPABASE_URL: 'http://127.0.0.1:9',
      SUPABASE_KEY: 'unused-in-tests',
      NODE_ENV: 'production',
      ...env,
    },
  });
  if (res.status !== 0) {
    throw new Error(`probe exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  const line = res.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe did not print JSON\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
}

const reqWith = (deviceId) => `{ headers: { 'x-device-token': 'secret-A' }, body: { deviceId: ${JSON.stringify(deviceId)} } }`;
const reqWithToken = (token, deviceId) => `{ headers: { 'x-device-token': ${JSON.stringify(token)} }, body: { deviceId: ${JSON.stringify(deviceId)} } }`;

async function run() {
  await test('valid, non-revoked device: both resolvers return the same voice-device identity', async () => {
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A' },
      `console.log(JSON.stringify({
        a: resolveUserId.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
        b: callerIdentity.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
      }))`
    );
    assert.strictEqual(out.a, 'voice-device:LAPTOP-1');
    assert.strictEqual(out.b, 'voice-device:LAPTOP-1');
  });

  await test('revoked deviceId is rejected by BOTH resolvers even with the correct shared secret', async () => {
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A', NEXUS_VOICE_DEVICE_REVOKED_IDS: 'STOLEN-LAPTOP' },
      `console.log(JSON.stringify({
        revoked_a: resolveUserId.resolveVoiceDeviceUserId(${reqWith('STOLEN-LAPTOP')}),
        revoked_b: callerIdentity.resolveVoiceDeviceUserId(${reqWith('STOLEN-LAPTOP')}),
        other_a: resolveUserId.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
        other_b: callerIdentity.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
      }))`
    );
    assert.strictEqual(out.revoked_a, null, 'resolveUserId.js must reject the revoked device');
    assert.strictEqual(out.revoked_b, null, 'callerIdentity.js must reject the revoked device');
    // revoking one device must not affect any other device sharing the secret
    assert.strictEqual(out.other_a, 'voice-device:LAPTOP-1');
    assert.strictEqual(out.other_b, 'voice-device:LAPTOP-1');
  });

  await test('revocation list can name several devices; only those are blocked', async () => {
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A', NEXUS_VOICE_DEVICE_REVOKED_IDS: 'BAD-1, BAD-2' },
      `console.log(JSON.stringify({
        bad1: resolveUserId.resolveVoiceDeviceUserId(${reqWith('BAD-1')}),
        bad2: resolveUserId.resolveVoiceDeviceUserId(${reqWith('BAD-2')}),
        ok: resolveUserId.resolveVoiceDeviceUserId(${reqWith('GOOD-1')}),
      }))`
    );
    assert.strictEqual(out.bad1, null);
    assert.strictEqual(out.bad2, null);
    assert.strictEqual(out.ok, 'voice-device:GOOD-1');
  });

  await test('rotated token: an already-paired device using the OLD (PREVIOUS) token keeps working if not revoked', async () => {
    const out = probe(
      {
        NEXUS_VOICE_DEVICE_TOKEN: 'secret-NEW',
        NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS: 'secret-OLD',
      },
      `console.log(JSON.stringify({
        viaOld: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('secret-OLD', 'LAPTOP-1')}),
        viaNew: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('secret-NEW', 'LAPTOP-1')}),
      }))`
    );
    assert.strictEqual(out.viaOld, 'voice-device:LAPTOP-1');
    assert.strictEqual(out.viaNew, 'voice-device:LAPTOP-1');
  });

  await test('rotated token: revocation still applies no matter which of the accepted tokens (new or previous) is used', async () => {
    const out = probe(
      {
        NEXUS_VOICE_DEVICE_TOKEN: 'secret-NEW',
        NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS: 'secret-OLD',
        NEXUS_VOICE_DEVICE_REVOKED_IDS: 'STOLEN-LAPTOP',
      },
      `console.log(JSON.stringify({
        viaOld: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('secret-OLD', 'STOLEN-LAPTOP')}),
        viaNew: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('secret-NEW', 'STOLEN-LAPTOP')}),
      }))`
    );
    assert.strictEqual(out.viaOld, null);
    assert.strictEqual(out.viaNew, null);
  });

  await test('a token that is neither current nor previous is rejected regardless of revocation list', async () => {
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-NEW', NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS: 'secret-OLD' },
      `console.log(JSON.stringify({
        viaWrong: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('totally-wrong', 'LAPTOP-1')}),
      }))`
    );
    assert.strictEqual(out.viaWrong, null);
  });

  await test('revocation never leaks through an invalid-secret request: wrong secret is rejected before the revocation check runs', async () => {
    // Observable effect of the ordering documented in both source files:
    // a caller with the WRONG secret gets null either way (revoked or
    // not), so there is no way to probe "is this deviceId revoked?"
    // without already holding a valid secret.
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A', NEXUS_VOICE_DEVICE_REVOKED_IDS: 'LAPTOP-1' },
      `console.log(JSON.stringify({
        revokedDeviceWrongSecret: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('wrong', 'LAPTOP-1')}),
        normalDeviceWrongSecret: resolveUserId.resolveVoiceDeviceUserId(${reqWithToken('wrong', 'LAPTOP-2')}),
      }))`
    );
    assert.strictEqual(out.revokedDeviceWrongSecret, null);
    assert.strictEqual(out.normalDeviceWrongSecret, null);
  });

  await test('no deviceId sent: defaults to the fixed "voice-device" id, and that default id can itself be revoked', async () => {
    const withDefault = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A' },
      `console.log(JSON.stringify({
        a: resolveUserId.resolveVoiceDeviceUserId({ headers: { 'x-device-token': 'secret-A' }, body: {} }),
      }))`
    );
    assert.strictEqual(withDefault.a, 'voice-device:voice-device');

    const revokedDefault = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A', NEXUS_VOICE_DEVICE_REVOKED_IDS: 'voice-device' },
      `console.log(JSON.stringify({
        a: resolveUserId.resolveVoiceDeviceUserId({ headers: { 'x-device-token': 'secret-A' }, body: {} }),
      }))`
    );
    assert.strictEqual(revokedDefault.a, null);
  });

  await test('cross-device access: the shared secret never grants access to another device\'s identity; a chosen deviceId only ever resolves to its own voice-device:<id>', async () => {
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A' },
      `console.log(JSON.stringify({
        d1: resolveUserId.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
        d2: resolveUserId.resolveVoiceDeviceUserId(${reqWith('LAPTOP-2')}),
      }))`
    );
    assert.notStrictEqual(out.d1, out.d2, 'two different deviceIds must not collapse to the same label');
    assert.strictEqual(out.d1, 'voice-device:LAPTOP-1');
    assert.strictEqual(out.d2, 'voice-device:LAPTOP-2');
  });

  await test('wrong/cross-workspace: nothing about the voice-device identity carries a workspace, so it cannot be used to claim one', async () => {
    // The voice-device identity is a bare string 'voice-device:<deviceId>'
    // with no workspace component at all -- workspace membership for any
    // tenant-scoped route is resolved separately via
    // services/workspaceService.js's resolveContext(), keyed off the
    // caller's real uid (never off this label), so the revocation
    // feature (or the deviceId label generally) gives a caller no way to
    // assert membership in any workspace, theirs or anyone else's.
    const out = probe(
      { NEXUS_VOICE_DEVICE_TOKEN: 'secret-A' },
      `console.log(JSON.stringify({
        id: resolveUserId.resolveVoiceDeviceUserId(${reqWith('LAPTOP-1')}),
      }))`
    );
    assert.strictEqual(out.id, 'voice-device:LAPTOP-1');
    assert.ok(!/workspace/i.test(out.id), 'voice-device identity string must carry no workspace claim');
  });

  await test('cross-device access via the REAL per-device pairing flow stays isolated: device_tokens rows never resolve through the shared-secret voice-device:* identity space', async () => {
    // backend-addon/devicePairing.js's paired-device flow is a
    // completely separate identity source (device_tokens(user_id,
    // device_id, token), looked up via Authorization: Bearer <token> in
    // resolveUserId()/resolveUserId.js's resolveAuthenticatedUserId) --
    // confirm the two never cross: a paired-device Bearer token resolves
    // to a real user_id, NEVER to a 'voice-device:*' label, even when no
    // X-Device-Token header is present at all.
    const src = require('fs').readFileSync(path.join(ROOT, 'backend-routing', 'resolveUserId.js'), 'utf8');
    // resolveUserId() (the paired-token / Firebase path) returns
    // decoded.uid or data.user_id -- it has no code path that can
    // construct a 'voice-device:' prefixed string; only
    // resolveVoiceDeviceUserId() does that, and it is gated on the
    // X-Device-Token header, which a paired-device Bearer-token request
    // never sends.
    const resolveUserIdBody = src.slice(src.indexOf('async function resolveUserId'), src.indexOf('resolveAuthenticatedUserId'));
    assert.ok(!resolveUserIdBody.includes('voice-device:'), 'the paired-token resolver must never construct a voice-device label');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
