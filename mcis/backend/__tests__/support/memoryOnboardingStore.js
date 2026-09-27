/**
 * TEST-ONLY in-memory user_onboarding store (mirrors
 * migrations/20260930_layer8_customer.up.sql: one row per user, CAS on
 * version, step / use_case / template_id checks).
 */
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const STEPS = ['workspace', 'team', 'use_case', 'template', 'first_run', 'done'];

function check(row) {
  if (!STEPS.includes(row.step)) throw Object.assign(new Error('bad step'), { code: '23514' });
  if (row.use_case != null && !/^[a-z][a-z0-9_]{1,40}$/.test(row.use_case)) throw Object.assign(new Error('bad use case'), { code: '23514' });
  if (row.template_id != null && !/^[a-z][a-z0-9_]{1,63}$/.test(row.template_id)) throw Object.assign(new Error('bad template'), { code: '23514' });
}

function createMemoryOnboardingStore({ now = () => new Date() } = {}) {
  const rows = new Map();
  return {
    _rows: rows,
    async getOnboarding(userId) { await tick(); return clone(rows.get(userId) || null); },
    async insertOnboarding(row) {
      await tick();
      if (rows.has(row.user_id)) return null;
      const r = {
        step: 'workspace', personal_workspace_id: null, company_workspace_id: null, invites_sent: 0, invites_skipped: false,
        use_case: null, template_id: null, first_workflow_id: null, first_run_id: null, completed_at: null,
        created_at: now().toISOString(), updated_at: now().toISOString(), ...clone(row), version: 1,
      };
      check(r);
      rows.set(row.user_id, r);
      return clone(r);
    },
    async updateOnboarding(userId, expectedVersion, patch) {
      await tick();
      const r = rows.get(userId);
      if (!r || r.version !== expectedVersion) return null;
      const next = { ...r, ...clone(patch), version: expectedVersion + 1, updated_at: now().toISOString() };
      check(next);
      rows.set(userId, next);
      return clone(next);
    },
  };
}

module.exports = { createMemoryOnboardingStore };
