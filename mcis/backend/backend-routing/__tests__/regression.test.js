/**
 * PASS 1-3 regression suite — plain Node + `assert`, no test framework
 * dependency (jest/mocha etc. weren't already present in this backend,
 * and adding one for this scope would be exactly the kind of
 * unnecessary infrastructure Phase A/G explicitly warn against).
 *
 * Run directly: node backend-routing/__tests__/regression.test.js
 *
 * This consolidates the ad-hoc tests run manually while building PASS
 * 1 (clarification), PASS 2 (risk model), and PASS 3 (adaptive
 * recovery) into a single file that can be re-run after any future
 * change to catch a regression, instead of those checks only having
 * existed as one-off commands typed during development.
 */

'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

const ROUTING_DIR = path.join(__dirname, '..');

function fakeModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

async function run() {
  // ---------------------------------------------------------------
  // PASS 2: risk classification (GREEN / YELLOW / RED)
  // ---------------------------------------------------------------
  {
    const { classifyRisk } = require(path.join(ROUTING_DIR, 'riskModel.js'));

    await test('risk: open_app is GREEN', () => {
      assert.strictEqual(classifyRisk('open_app', { parameters: { app: 'notepad' } }), 'green');
    });
    await test('risk: close_app is GREEN (reclassified from the old always-RED list)', () => {
      assert.strictEqual(classifyRisk('close_app', { parameters: { app: 'notepad' } }), 'green');
    });
    await test('risk: move_file is YELLOW', () => {
      assert.strictEqual(classifyRisk('move_file', { parameters: { path: 'C:/a.txt' } }), 'yellow');
    });
    await test('risk: delete_file is RED', () => {
      assert.strictEqual(classifyRisk('delete_file', { parameters: { path: 'C:/important.docx' } }), 'red');
    });
    await test('risk: a click on "Book this hotel" is RED via payload keyword', () => {
      assert.strictEqual(classifyRisk('click', { target: { text: 'Book this hotel' } }), 'red');
    });
  }

  // ---------------------------------------------------------------
  // PASS 1: pending-clarification round trip (taskContext.js)
  // ---------------------------------------------------------------
  {
    delete require.cache[require.resolve(path.join(ROUTING_DIR, 'taskContext.js'))];
    const taskContext = require(path.join(ROUTING_DIR, 'taskContext.js'));

    await test('context: fresh user has no pending clarification', () => {
      assert.strictEqual(taskContext.getPendingClarification('regress-user-A'), null);
    });
    await test('context: pending clarification is stored and cleared correctly', () => {
      taskContext.setPendingClarification('regress-user-A', 'Which one — Chrome or VS Code?', 'close it');
      const pending = taskContext.getPendingClarification('regress-user-A');
      assert.ok(pending && pending.question.includes('Which one'));
      taskContext.clearPendingClarification('regress-user-A');
      assert.strictEqual(taskContext.getPendingClarification('regress-user-A'), null);
    });
    await test('context: result set is indexable for "the first one" style references', () => {
      taskContext.setResults('regress-user-A', [{ name: 'Hotel Taj' }, { name: 'Hotel Marriott' }]);
      const pc = taskContext.toPromptContext('regress-user-A');
      assert.strictEqual(pc.results[0].index, 1);
      assert.strictEqual(pc.results[0].data.name, 'Hotel Taj');
      taskContext.clearContext('regress-user-A');
    });
  }

  // ---------------------------------------------------------------
  // PASS 3: multi-step planner — happy path, safe retry, diagnose-on-
  // failure, and bounded abort. Each sub-test mocks geminiClient.js and
  // nexusBridge.js fresh so they don't interfere with each other.
  // ---------------------------------------------------------------
  {
    const geminiPath = require.resolve(path.join(ROUTING_DIR, 'geminiClient.js'));
    const nexusBridgePath = require.resolve(path.join(ROUTING_DIR, 'nexusBridge.js'));
    const taskPlannerPath = require.resolve(path.join(ROUTING_DIR, 'taskPlanner.js'));

    function freshTaskPlanner(scriptFn, execFn) {
      delete require.cache[taskPlannerPath];
      fakeModule(geminiPath, { generateContent: scriptFn });
      fakeModule(nexusBridgePath, { sendCommandToNexus: execFn });
      return require(taskPlannerPath);
    }

    await test('planner: 4-step goal completes fully, no duplicate execution on ambiguous verification', async () => {
      const script = [
        { done: false, action: 'open_app', payload: { platform: 'desktop', parameters: { app: 'notepad' }, target: {}, value: null }, reason: 'open' },
        { done: false, action: 'type_text', payload: { platform: 'desktop', parameters: {}, target: { role: 'editor' }, value: 'hello' }, reason: 'type' },
        { done: false, action: 'create_file', payload: { platform: 'desktop', parameters: { path: 'C:/tmp/note.txt' }, target: {}, value: null }, reason: 'save' },
        { done: false, action: 'open_file', payload: { platform: 'desktop', parameters: { path: 'C:/tmp/note.txt' }, target: {}, value: null }, reason: 'open saved' },
        { done: true, action: null, payload: {}, reason: 'done' },
      ];
      let i = 0;
      const calls = [];
      const taskPlanner = freshTaskPlanner(
        async () => ({ response: { text: () => JSON.stringify(script[i++]) } }),
        async (req) => { calls.push(req.action); return { success: true, evidence: { verified: req.action !== 'type_text' }, data: null }; },
      );
      const result = await taskPlanner.startPlan('regress-planner-1', 'Open Notepad, type hello, save it, open it.');
      assert.strictEqual(result.type, 'plan_complete');
      assert.strictEqual(calls.length, 4);
      assert.strictEqual(calls.filter(a => a === 'type_text').length, 1, 'type_text must not be duplicated on ambiguous-but-successful verification');
    });

    await test('planner: RED-tier step still pauses for explicit confirmation', async () => {
      const script = [
        { done: false, action: 'delete_file', payload: { platform: 'desktop', parameters: { path: 'C:/important.docx' }, target: {}, value: null }, reason: 'delete' },
      ];
      let i = 0;
      const taskPlanner = freshTaskPlanner(
        async () => ({ response: { text: () => JSON.stringify(script[i++]) } }),
        async () => ({ success: true, evidence: { verified: true }, data: null }),
      );
      const result = await taskPlanner.startPlan('regress-planner-2', 'Delete the important file.');
      assert.strictEqual(result.type, 'plan_paused');
    });

    await test('planner: safe-to-repeat action failure uses plain retry, no diagnostic call', async () => {
      const script = [
        { done: false, action: 'open_app', payload: { platform: 'desktop', parameters: { app: 'notepad' }, target: {}, value: null }, reason: 'open' },
        { done: true, action: null, payload: {}, reason: 'done' },
      ];
      let i = 0;
      const calls = [];
      const taskPlanner = freshTaskPlanner(
        async () => ({ response: { text: () => JSON.stringify(script[i++]) } }),
        async (req) => {
          calls.push(req.action);
          if (req.action === 'open_app' && calls.filter(a => a === 'open_app').length === 1) {
            return { success: false, error: 'transient', evidence: null, data: null };
          }
          return { success: true, evidence: { verified: true }, data: null };
        },
      );
      const result = await taskPlanner.startPlan('regress-planner-3', 'Open notepad.');
      assert.strictEqual(result.type, 'plan_complete');
      assert.strictEqual(calls.filter(a => a === 'open_app').length, 2);
      assert.ok(!calls.includes('inspect_screen_state'), 'safe-to-repeat actions must not trigger a diagnostic call');
    });

    await test('planner: non-idempotent failure triggers diagnosis, not a blind resend', async () => {
      const script = [
        { done: false, action: 'click', payload: { platform: 'browser', parameters: {}, target: { text: 'Add to cart' }, value: null }, reason: 'click' },
        { done: true, action: null, payload: {}, reason: 'done' },
      ];
      let i = 0;
      const calls = [];
      const taskPlanner = freshTaskPlanner(
        async () => ({ response: { text: () => JSON.stringify(script[i++]) } }),
        async (req) => {
          calls.push(req.action);
          if (req.action === 'click') return { success: false, error: 'not found', evidence: null, data: null };
          if (req.action === 'inspect_page_state') return { success: true, evidence: { verified: true }, data: { url: 'x', dialog_open: true } };
          return { success: true, evidence: { verified: true }, data: null };
        },
      );
      const result = await taskPlanner.startPlan('regress-planner-4', 'Add to cart.');
      assert.ok(calls.includes('inspect_page_state'), 'a non-idempotent failure must trigger the bounded diagnostic call');
      assert.strictEqual(result.steps[0].diagnosis.dialog_open, true, 'diagnosis must be recorded in step history');
    });

    await test('planner: bounded recovery aborts after MAX_CONSECUTIVE_FAILURES, does not loop forever', async () => {
      let n = 0;
      const calls = [];
      const taskPlanner = freshTaskPlanner(
        async () => { n++; return { response: { text: () => JSON.stringify({ done: false, action: 'click', payload: { platform: 'browser', parameters: {}, target: { text: `attempt ${n}` }, value: null }, reason: 'trying' }) } }; },
        async (req) => { calls.push(req.action); return { success: false, error: 'still not found', evidence: null, data: null }; },
      );
      const result = await taskPlanner.startPlan('regress-planner-5', 'Click something that never appears.');
      assert.strictEqual(result.type, 'plan_error');
      assert.ok(calls.filter(a => a === 'click').length <= 3, 'must abort within the bounded recovery limit, not exhaust all 15 max steps');
    });
  }

  // ---------------------------------------------------------------
  // MCIS transport: commandId dedupe in commandRoute.js. Drives the
  // REAL Express router (not a reimplementation) through two requests
  // with the same commandId, simulating a client-side retry after a
  // dropped response -- the second must not re-execute the action.
  // ---------------------------------------------------------------
  {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
    process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'dummy-key';
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_UNAUTHENTICATED_API = 'true';

    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'config', 'firebaseAdmin')),
      () => ({ auth: () => ({ verifyIdToken: async () => { throw new Error('no token'); } }) }));
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'agentSocket')), { sendCommandToAgent: async () => ({ success: true }) });
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'memory-hooks', 'memoryHooks')), { logAction: async () => {} });
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'security-engine', 'permissions')), { isPermitted: async () => true });
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'security-engine', 'auditLog')), { appendAuditLog: async () => {} });
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'ai-tasks', 'aiTasks')), {});
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'productivity', 'productivity')), {});
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'productivity', 'calendar')), {});
    fakeModule(require.resolve(path.join(ROUTING_DIR, 'fastPath.js')), { tryFastPath: () => null }); // force LLM path
    fakeModule(require.resolve(path.join(ROUTING_DIR, '..', 'services', 'ai')), { askAI: async () => 'chat fallback' });

    let nexusCallCount = 0;
    fakeModule(require.resolve(path.join(ROUTING_DIR, 'nexusBridge.js')), {
      sendCommandToNexus: async () => { nexusCallCount++; return { success: true, evidence: { verified: true }, data: null }; },
    });
    fakeModule(require.resolve(path.join(ROUTING_DIR, 'intentRouter.js')), {
      NEXUS_ACTIONS: ['open_app'],
      classifyIntent: async () => ({ type: 'action', action: 'open_app', payload: { platform: 'desktop', parameters: { app: 'notepad' }, target: {}, value: null } }),
    });

    delete require.cache[require.resolve(path.join(ROUTING_DIR, 'commandRoute.js'))];
    const commandRoute = require(path.join(ROUTING_DIR, 'commandRoute.js'));
    const layer = commandRoute.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
    const handler = layer.route.stack[0].handle;

    function makeReqRes(body) {
      const req = { headers: {}, body };
      let jsonBody = null;
      const res = { status() { return res; }, json(obj) { jsonBody = obj; return res; } };
      return { req, res, get jsonBody() { return jsonBody; } };
    }

    await test('commandRoute: retrying the same commandId does not re-execute the action', async () => {
      const t1 = makeReqRes({ message: 'open notepad', deviceId: 'd1', commandId: 'dup-1' });
      await handler(t1.req, t1.res);
      const t2 = makeReqRes({ message: 'open notepad', deviceId: 'd1', commandId: 'dup-1' });
      await handler(t2.req, t2.res);
      assert.strictEqual(nexusCallCount, 1, 'a retried request with the SAME commandId must not execute the action twice');
      assert.strictEqual(t2.jsonBody.type, 'chat', 'the duplicate must short-circuit with a "already on it" response, not a real action result');
    });

    await test('commandRoute: a DIFFERENT commandId for the same message executes normally', async () => {
      const t3 = makeReqRes({ message: 'open notepad', deviceId: 'd1', commandId: 'dup-2' });
      await handler(t3.req, t3.res);
      assert.strictEqual(nexusCallCount, 2, 'a genuinely new commandId must execute normally');
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
