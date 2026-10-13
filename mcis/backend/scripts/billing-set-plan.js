#!/usr/bin/env node
/**
 * Layer 7 — OPERATOR tool: assign a plan to a workspace without an online
 * payment provider (e.g. a B2B customer paying by invoice / bank transfer).
 * Server-side only (needs the service-role key); every change is audited
 * as `billing.plan_assigned` with the operator's name.
 *
 *   node scripts/billing-set-plan.js --workspace <uuid> --plan pro --operator "ananya" \
 *        [--status active] [--period-days 30] [--note "invoice INV-104 paid"]
 *
 * Statuses: trialing | active | past_due | cancelled | expired.
 *
 * Layer 8 — Enterprise custom limits (manual activation, custom terms):
 *   node scripts/billing-set-plan.js --workspace <uuid> --plan enterprise --operator "ananya" \
 *        --limits '{"executions_per_month":50000,"max_members":200}'
 *   node scripts/billing-set-plan.js --workspace <uuid> --operator "ananya" --clear-limits yes
 * (number = cap, null = unlimited; only while the subscription is in force.)
 * Nothing here charges anyone; it records a decision the operator made.
 */
'use strict';

const path = require('path');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) { out[m[1]] = argv[i + 1]; i++; }
  }
  return out;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const a = args(process.argv.slice(2));
  if (!a.workspace || !a.operator || (!a.plan && !a['clear-limits'])) {
    console.error('usage: --workspace <uuid> --plan <id> --operator <name> [--status active] [--period-days 30] [--note text] [--limits JSON] | --clear-limits yes');
    process.exit(2);
  }
  const { createSupabaseBillingStore } = require('../services/billing/billingStore');
  const { createBillingAudit } = require('../services/billing/entitlementService');
  const { createSubscriptionService } = require('../services/billing/subscriptionService');
  const { createProviders } = require('../services/billing/providers');
  const { appendAuditLog } = require('../security-engine/auditLog');
  const store = createSupabaseBillingStore();
  const svc = createSubscriptionService({ store, providers: createProviders(), audit: createBillingAudit({ appendAuditLog }) });
  if (a['clear-limits']) {
    await svc.setPlanOverride(a.workspace, { limits: null, operator: a.operator, note: a.note || null });
    console.log(JSON.stringify({ workspace: a.workspace, customLimits: null }));
    if (!a.plan) return;
  }
  const days = a['period-days'] ? parseInt(a['period-days'], 10) : null;
  const start = new Date();
  const row = await svc.assignPlanManually(a.workspace, {
    planId: a.plan, status: a.status || 'active', operator: a.operator, note: a.note || null,
    periodStart: days ? start.toISOString() : null, periodEnd: days ? new Date(start.getTime() + days * 86400000).toISOString() : null,
  });
  console.log(JSON.stringify({ workspace: row.workspace_id, plan: row.plan_id, status: row.status, provider: row.provider, periodEnd: row.current_period_end }));
  if (a.limits) {
    let limits;
    try { limits = JSON.parse(a.limits); } catch { throw new Error('--limits must be JSON'); }
    const o = await svc.setPlanOverride(a.workspace, { limits, operator: a.operator, note: a.note || null });
    console.log(JSON.stringify({ workspace: a.workspace, customLimits: o.limits }));
  }
}

main().catch((err) => { console.error(`[billing-set-plan] ${err.message}`); process.exit(1); });
