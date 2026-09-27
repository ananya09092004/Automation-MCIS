#!/usr/bin/env node
/**
 * Layer 10 — mutation testing of the security- and honesty-critical checks.
 *
 *   node scripts/mutation-test.js [--only <regex>]
 *
 * Each mutation disables or weakens ONE check in the source, runs the
 * Layer 10 suite (__tests__/revenue.test.js, memory store) and expects it
 * to FAIL ("killed"). A surviving mutation means that check is untested.
 * Every file is restored after each mutation (also on errors / Ctrl-C).
 * Exit code: 0 all killed, 1 a mutation survived, 2 a mutation did not apply.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const M = (file, find, replace, why) => ({ file, find, replace, why });
const MUTATIONS = [
  M('services/actions/connectorActions.js', "if (plan.decision !== 'ALLOW') {", 'if (false) {', 'plan-time firewall decision ignored'),
  M('services/actions/connectorActions.js', "} else if (prepared.tier !== 'green') {", '} else if (false) {', 'firewall off: non-green actions run unattended'),
  M('services/actions/connectorActions.js', 'firewallTicket: ticket,', 'firewallTicket: undefined,', 'ticket not passed to the gateway'),
  M('services/monitoring/normalize.js', "if (oa !== ca && oa !== 'UNKNOWN' && ca !== 'UNKNOWN') {", 'if (oa !== ca) {', 'UNKNOWN stock treated as a transition'),
  M('services/monitoring/normalize.js', "if (v === null || v === undefined || v === '') return null;", "if (v === null || v === undefined || v === '') return 0;", 'missing price becomes 0'),
  M('services/revenue/monitoringService.js', "Object.assign(patch, { health: 'UNAVAILABLE',", "Object.assign(patch, { health: 'VERIFIED',", 'failed check reported as verified'),
  M('services/revenue/monitoringService.js', 'currentIsFresh: !!m.current && (m.health === \'VERIFIED\' || m.health === \'UNVERIFIED\') && !isStale(m),', 'currentIsFresh: !!m.current,', 'stale data presented as current'),
  M('services/revenue/monitoringService.js', "status: 'UNVERIFIED', values, method: 'api_submission'", "status: 'VERIFIED', values, method: 'api_submission'", 'API-submitted data marked verified'),
  M('services/revenue/monitoringService.js', 'const run = prev.then(fn, fn);', 'const run = fn();', 'per-monitor apply lock removed (concurrent submissions starve)'),
  M('services/revenue/monitoringService.js', 'if (res.blocked) await usage.release(handle);', 'if (false) await usage.release(handle);', 'blocked checks are charged'),
  M('services/revenue/monitoringService.js', 'values: sanitize(outcome0.values, { maxString: 300 })', 'values: outcome0.values', 'secrets in observed values stored'),
  M('services/integrations/connectors/webPageConnector.js', 'if (!hostAllowed(u.hostname.toLowerCase(), config.allowedHosts))', 'if (false)', 'web_page host allowlist removed'),
  M('services/integrations/connectors/webPageConnector.js', 'contentHash: hash(res.body), defaultCurrency', 'raw: res.body, contentHash: hash(res.body), defaultCurrency', 'raw page content returned'),
  M('services/integrations/connectors/slackConnector.js', 'u.hostname !== webhookHost ||', 'false ||', 'Slack webhook host not checked'),
  M('services/integrations/connectors/emailConnector.js', "const to = action === 'notify' ? config.alertRecipients : [input.to];", "const to = input.to ? [input.to] : config.alertRecipients;", 'notify recipients taken from input'),
  M('services/integrations/connectors/emailConnector.js', 'if (!config.allowedRecipientDomains.includes(domain))', 'if (false)', 'send_email domain allowlist removed'),
  M('services/integrations/connectors/httpApiConnector.js', "if (!HEADER_RE.test(k) || reserved.has(lk) ||", 'if (!HEADER_RE.test(k) ||', 'reserved request headers allowed'),
  M('services/revenue/matching.js', 'if (conflicts.length) return', 'if (false) return', 'identifier conflicts ignored'),
  M('services/revenue/matching.js', "status: best.confidence >= 0.95 ? 'VERIFIED'", "status: best.confidence >= 0.85 ? 'VERIFIED'", 'brand+model auto-verified'),
  M('services/revenue/margin.js', "if (num(product.fees_fixed) === null && num(product.fees_pct) === null) missing.push('fees');", '', 'fees assumed 0'),
  M('services/revenue/competitorService.js', "if (competitor.match_status !== 'VERIFIED') continue;", '', 'recommendations from unverified matches'),
  M('services/revenue/competitorService.js', "if (ch.verification !== 'VERIFIED') continue;", '', 'recommendations from unverified data'),
  M('services/revenue/competitorService.js', "{ filter: { product_id: p.id, confirmed_by: null }, limit: 1000 }", '{ filter: { product_id: p.id }, limit: 1000 }', 'human match decisions overridden'),
  M('services/revenue/competitorService.js', 'if (usage && usage.enforceCount) {', 'if (false) {', 'monitored-products limit not enforced'),
  M('services/revenue/alertService.js', "(!l.competitor || l.competitor.match_status === 'VERIFIED')", 'true', 'product alerts from unverified matches'),
  M('services/revenue/alertService.js', 'if (recent) return null; // throttled', '', 'cooldown ignored'),
  M('services/revenue/alertService.js', "status: res.blocked ? 'blocked' : 'failed'", "status: 'delivered'", 'failed delivery reported as delivered'),
  M('services/revenue/alertService.js', '{ id: d.id, status: d.status, attempts: d.attempts }', '{ id: d.id }', 'retry claim not atomic'),
  M('services/revenue/qaVerifier.js', "(failed.includes('independent_probe') || failed.includes('verified'))", 'false', 'false success not detected'),
  M('services/revenue/qaService.js', "if (FINAL.has(x.status)) return { replayed: true, result: resultView(x) };", "if (FINAL.has(x.status)) throw C.conflict('x', 'QA_RESULT_BUSY');", 'external result replay broken'),
  M('services/revenue/qaService.js', 'idempotencyKey: `qa:${result.id}`', 'idempotencyKey: `qa:${crypto.randomUUID()}`', 'QA start not idempotent'),
  M('services/revenue/webhookService.js', "'Nexus-Signature': sign(secret, body, t)", "'Nexus-Signature': sign('x', body, t)", 'webhook signed with the wrong secret'),
  M('services/revenue/webhookService.js', 'if (isInternalHostname(u.hostname) ||', 'if (false ||', 'internal webhook hosts allowed'),
  M('services/agentExecution/executionService.js', 'if (TIER_RANK[tier] === undefined || TIER_RANK[tier] > TIER_RANK[a.maxRisk]) return', 'if (false) return', 'agent risk cap removed'),
  M('services/agentExecution/executionService.js', "if (step.connector && a.allowedIntegrationIds.length && !a.allowedIntegrationIds.includes(step.connector.spec.integrationId)) return", 'if (false) return', 'agent integration allowlist removed'),
  M('services/workflows/workflowService.js', "if (!(role === 'member' ? !!ctx.role : isAdmin(ctx))) throw", 'if (false) throw', 'review role not checked'),
  M('services/revenue/workspaceLifecycle.js', "if (SECRET_KEY_RE.test(k) && !/^(has|secretNotice)/.test(k)) continue;", '', 'export not scrubbed'),
  M('services/revenue/workspaceLifecycle.js', "if (typeof body.confirmName !== 'string' || body.confirmName !== ctx.workspace.name) throw", 'if (false) throw', 'delete without confirmation'),
  M('services/revenue/workspaceLifecycle.js', "if (online && ['trialing', 'active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end) {", 'if (false) {', 'delete with an active subscription'),
  M('routes/automation.js', "apiKeyService.requireScope(req.apiContext, 'monitoring:write');", '', 'monitoring:write scope not required'),
  M('backend-routing/sensitiveDataFilter.js', '[/(?<![-\\w])[2-9]\\d{3}\\s?\\d{4}\\s?\\d{4}(?![-\\w])/g', '[/\\b[2-9]\\d{3}\\s?\\d{4}\\s?\\d{4}\\b/g', 'UUIDs redacted as Aadhaar numbers again'),
  M('services/workflows/workflowRunner.js', "        if (!running) {\n          if (!stoppedAbandon)", "        if (false) {\n          if (!stoppedAbandon)", 'stopped runner drives a late claim'),
  M('services/billing/plans.js', 'return optional ? null : 0;', 'return null;', 'missing limits fail open for old capabilities'),
];

const only = process.argv.includes('--only') ? new RegExp(process.argv[process.argv.indexOf('--only') + 1]) : null;
const originals = new Map();
const restoreAll = () => { for (const [f, c] of originals) fs.writeFileSync(f, c); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

let killed = 0; let survived = 0; let broken = 0;
for (const m of MUTATIONS) {
  if (only && !only.test(m.why)) continue;
  const f = path.join(ROOT, m.file);
  const src = fs.readFileSync(f, 'utf8');
  originals.set(f, src);
  if (!src.includes(m.find)) { console.log(`NOT APPLIED  ${m.why} (${m.file})`); broken++; continue; }
  try {
    fs.writeFileSync(f, src.replace(m.find, m.replace));
    const r = spawnSync(process.execPath, ['__tests__/revenue.test.js'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (r.status === 0) { survived++; console.log(`SURVIVED     ${m.why} (${m.file})`); } else { killed++; console.log(`killed       ${m.why}`); }
  } finally {
    fs.writeFileSync(f, src);
  }
}
restoreAll();
console.log(`\n${killed} killed, ${survived} survived, ${broken} not applied (of ${MUTATIONS.length})`);
process.exit(survived ? 1 : broken ? 2 : 0);
