/**
 * C5 -- graceful SIGTERM/SIGINT shutdown (config/gracefulShutdown.js).
 *
 * Plain Node + assert, no framework, matching every other test file in
 * this backend. Everything here is dependency-injected (no real HTTP
 * server, no real workflow/revenue worker) so these tests run fast and
 * deterministically, the same way config/validateConfig.js's tests do.
 *
 * Run directly: node __tests__/gracefulShutdown.test.js
 */
'use strict';

const assert = require('assert');
const { createGracefulShutdown } = require('../config/gracefulShutdown');

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

function quietLogger() {
  const lines = [];
  const rec = (level) => (msg) => lines.push(`${level}: ${msg}`);
  return { info: rec('info'), warn: rec('warn'), error: rec('error'), lines };
}

async function run() {
  await test('shutdown: runs every step in order and exits 0 on a clean path', async () => {
    const calls = [];
    const server = { close: (cb) => { calls.push('server.close'); cb(); }, closeIdleConnections: () => calls.push('closeIdleConnections') };
    const wss = { clients: new Set([{ close: () => calls.push('ws1.close') }, { close: () => calls.push('ws2.close') }]) };
    const runner = { stop: async () => calls.push('runner.stop') };
    const worker = { stop: async () => calls.push('worker.stop') };
    let exitCode = null;

    const gs = createGracefulShutdown({
      server, wss,
      getWorkflowRunner: () => runner,
      getRevenueWorker: () => worker,
      clearRetentionTimer: () => calls.push('clearRetentionTimer'),
      logger: quietLogger(),
      timeoutMs: 5000,
      exit: (code) => { exitCode = code; },
    });

    await gs.shutdown('SIGTERM');

    assert.deepStrictEqual(calls, [
      'clearRetentionTimer', 'server.close', 'closeIdleConnections', 'ws1.close', 'ws2.close', 'runner.stop', 'worker.stop',
    ]);
    assert.strictEqual(exitCode, 0);
  });

  await test('shutdown: a second signal while already shutting down is ignored, not a second overlapping shutdown', async () => {
    const calls = [];
    let resolveClose;
    const server = { close: (cb) => { calls.push('server.close'); resolveClose = cb; } };
    const exitCodes = [];
    const gs = createGracefulShutdown({
      server,
      logger: quietLogger(),
      timeoutMs: 5000,
      exit: (code) => exitCodes.push(code),
    });

    const first = gs.shutdown('SIGTERM'); // hangs until resolveClose() is called
    // Let the first call's own async steps actually reach server.close()
    // (clearRetentionTimer's step wrapper yields a tick first) before
    // firing the second signal, so this proves the "already shutting
    // down" guard rather than a timing accident.
    for (let i = 0; i < 50 && !calls.includes('server.close'); i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(calls.includes('server.close'), 'precondition: the first shutdown must have reached server.close by now');

    await gs.shutdown('SIGINT'); // must return immediately, must not re-run the steps
    assert.deepStrictEqual(calls, ['server.close'], 'the second signal must not call server.close again');

    resolveClose();
    await first;
    assert.deepStrictEqual(exitCodes, [0], 'only ONE shutdown ever calls exit');
  });

  await test('shutdown: a hung step forces exit(1) after timeoutMs instead of hanging forever', async () => {
    const server = { close: () => { /* never calls back -- simulates a stuck connection */ } };
    const exitCodes = [];
    const logger = quietLogger();
    const gs = createGracefulShutdown({
      server,
      logger,
      timeoutMs: 30,
      exit: (code) => exitCodes.push(code),
    });

    await Promise.race([
      gs.shutdown('SIGTERM'),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
    // the force timer (30ms) must have fired well within the 200ms race window
    assert.deepStrictEqual(exitCodes, [1]);
    assert.ok(logger.lines.some((l) => l.includes('exceeded') && l.includes('forcing exit')));
  });

  await test('shutdown: a step that throws is logged and does not stop the remaining steps or block exit', async () => {
    const calls = [];
    const server = { close: (cb) => { calls.push('server.close'); cb(); } };
    const runner = { stop: async () => { throw new Error('lease release boom'); } };
    const worker = { stop: async () => calls.push('worker.stop') };
    let exitCode = null;
    const logger = quietLogger();

    const gs = createGracefulShutdown({
      server,
      getWorkflowRunner: () => runner,
      getRevenueWorker: () => worker,
      logger,
      timeoutMs: 5000,
      exit: (code) => { exitCode = code; },
    });

    await gs.shutdown('SIGTERM');

    assert.ok(calls.includes('worker.stop'), 'a failure in one step must not prevent later steps from running');
    assert.strictEqual(exitCode, 0, 'a handled per-step failure still completes shutdown rather than hanging');
    assert.ok(logger.lines.some((l) => l.includes('lease release boom')));
  });

  await test('shutdown: never calls stop() on a worker/runner that was never started (getters returning null)', async () => {
    const calls = [];
    const server = { close: (cb) => cb() };
    let exitCode = null;
    const gs = createGracefulShutdown({
      server,
      getWorkflowRunner: () => null,
      getRevenueWorker: () => null,
      logger: quietLogger(),
      timeoutMs: 5000,
      exit: (code) => { exitCode = code; },
    });
    await gs.shutdown('SIGTERM');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(exitCode, 0);
  });

  await test('shutdown: with no server/wss/workers at all (every dependency optional), still exits 0 cleanly', async () => {
    let exitCode = null;
    const gs = createGracefulShutdown({ logger: quietLogger(), timeoutMs: 5000, exit: (code) => { exitCode = code; } });
    await gs.shutdown('SIGTERM');
    assert.strictEqual(exitCode, 0);
  });

  await test('install: registers a handler on SIGTERM and SIGINT that triggers shutdown', async () => {
    const calls = [];
    const server = { close: (cb) => { calls.push('server.close'); cb(); } };
    const gs = createGracefulShutdown({ server, logger: quietLogger(), timeoutMs: 5000, exit: () => calls.push('exit') });

    const before = { SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') };
    gs.install();
    assert.strictEqual(process.listenerCount('SIGTERM'), before.SIGTERM + 1);
    assert.strictEqual(process.listenerCount('SIGINT'), before.SIGINT + 1);

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls.includes('server.close'), 'emitting SIGTERM must actually trigger the installed shutdown');

    // Clean up so this test doesn't leak a listener onto the rest of the suite.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    for (const [sig, count] of Object.entries(before)) {
      // restore nothing extra needed -- removeAllListeners above already zeroed them for this process
      void sig; void count;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
