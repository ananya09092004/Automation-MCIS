'use strict';

/**
 * C5 -- graceful SIGTERM/SIGINT shutdown.
 *
 * Before this, the process had no signal handlers at all (only
 * unhandledRejection/uncaughtException, which log and keep running).
 * A SIGTERM from a host's deploy/scale-down (Render, Kubernetes, etc.)
 * or a developer's Ctrl+C just killed the process mid-request, mid-
 * workflow-step, with whatever leases/connections it happened to be
 * holding at that instant.
 *
 * This module is intentionally dependency-injected (server, workers,
 * timer, logger all passed in) so it can be unit tested the same way
 * config/validateConfig.js is, without needing a real HTTP server,
 * Supabase, or Firebase.
 *
 * Shutdown order, each step best-effort and never throwing past its
 * own step:
 *   1. Stop any periodic in-process timers (e.g. the retention sweep)
 *      so nothing NEW starts once we've decided to shut down.
 *   2. server.close() -- stop accepting new HTTP connections/WS
 *      upgrades, then closeIdleConnections() (Node >= 18.2) so
 *      keep-alive sockets with no in-flight request drop immediately
 *      instead of holding the process open indefinitely; a genuinely
 *      in-flight request is still allowed to finish naturally.
 *   3. Close already-upgraded WebSocket connections (agentSocket.js's
 *      wss) -- server.close() does not touch these.
 *   4. Stop the Layer 4 workflow runner -- its own stop() already
 *      waits (bounded by its own stopTimeoutMs) for active drivers to
 *      finish their current step and release their lease cleanly,
 *      rather than abandoning it for another worker to recover.
 *   5. Stop the Layer 10 revenue worker the same way.
 *
 * The whole sequence is wrapped in one overall timeoutMs: if anything
 * above hangs (a stuck connection, a step that never resolves), this
 * forces process.exit(1) rather than leaving the process (and
 * whatever's orchestrating it -- a container runtime, a process
 * manager) waiting forever. A second SIGTERM/SIGINT while already
 * shutting down is logged and ignored, not treated as a second,
 * overlapping shutdown.
 */
function createGracefulShutdown({
  server,
  wss = null,
  getWorkflowRunner = () => null,
  getRevenueWorker = () => null,
  clearRetentionTimer = () => {},
  logger = console,
  timeoutMs = 10000,
  exit = (code) => process.exit(code),
} = {}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      logger.warn(`[shutdown] ${signal} received again while already shutting down -- ignoring`);
      return;
    }
    shuttingDown = true;
    logger.info(`[shutdown] ${signal} received: starting graceful shutdown (max ${timeoutMs}ms)`);

    let forced = false;
    const forceTimer = setTimeout(() => {
      forced = true;
      logger.error(`[shutdown] exceeded ${timeoutMs}ms -- forcing exit`);
      exit(1);
    }, timeoutMs);
    if (forceTimer.unref) forceTimer.unref();

    const step = async (name, fn) => {
      if (forced) return;
      try {
        await fn();
      } catch (err) {
        logger.error(`[shutdown] ${name} failed: ${err && err.message}`);
      }
    };

    await step('clearRetentionTimer', clearRetentionTimer);

    await step('server.close', () => new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      // Node >= 18.2: drop idle keep-alive sockets now; a socket with a
      // request actually in flight is left alone and finishes normally.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    }));

    await step('close websocket clients', () => {
      if (!wss || !wss.clients) return;
      for (const client of wss.clients) {
        try { client.close(1001, 'Server shutting down'); } catch { /* best effort */ }
      }
    });

    await step('workflow runner stop', async () => {
      const runner = getWorkflowRunner();
      if (runner && typeof runner.stop === 'function') await runner.stop();
    });

    await step('revenue worker stop', async () => {
      const worker = getRevenueWorker();
      if (worker && typeof worker.stop === 'function') await worker.stop();
    });

    if (forced) return; // the force-exit branch above already called exit(1)
    clearTimeout(forceTimer);
    logger.info('[shutdown] graceful shutdown complete');
    exit(0);
  }

  function install(signals = ['SIGTERM', 'SIGINT']) {
    for (const signal of signals) process.on(signal, () => shutdown(signal));
  }

  return { shutdown, install };
}

module.exports = { createGracefulShutdown };
