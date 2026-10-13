/**
 * Layer 7 — Supabase persistence for plans, subscriptions, the usage
 * ledger, quota reservations and the webhook ledger.
 * Tables / RPCs: migrations/20260929_layer7_billing.up.sql
 * Every workspace query is filtered by workspace_id.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}
function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.dbError = true;
    throw err;
  }
  return data;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);
const nowIso = () => new Date().toISOString();

function createSupabaseBillingStore() {
  return {
    async listPlans() {
      return unwrap(await db().from('billing_plans').select('*').order('sort_order', { ascending: true }));
    },
    async getPlan(id) {
      return first(unwrap(await db().from('billing_plans').select('*').eq('id', id).limit(1)));
    },
    async getSubscription(workspaceId) {
      return first(unwrap(await db().from('workspace_subscriptions').select('*').eq('workspace_id', workspaceId).limit(1)));
    },
    async findSubscriptionByExternal(provider, externalSubscriptionId) {
      return first(unwrap(await db().from('workspace_subscriptions').select('*')
        .eq('provider', provider).eq('external_subscription_id', externalSubscriptionId).limit(1)));
    },
    /** CAS: expectedVersion 0 = create. Returns the row, or null on conflict. */
    async saveSubscription(workspaceId, expectedVersion, patch) {
      if (expectedVersion === 0) {
        const { data, error } = await db().from('workspace_subscriptions').insert({ ...patch, workspace_id: workspaceId, version: 1 }).select('*');
        if (error && error.code === '23505') return null;
        return first(unwrap({ data, error }));
      }
      return first(unwrap(await db().from('workspace_subscriptions')
        .update({ ...patch, version: expectedVersion + 1, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('version', expectedVersion).select('*')));
    },
    async workspaceExists(workspaceId) {
      return !!first(unwrap(await db().from('workspaces').select('id').eq('id', workspaceId).limit(1)));
    },

    async reserveUsage({ workspaceId, metric, quantity, limit, periodStart, periodEnd, key, ttlSeconds }) {
      const r = first(unwrap(await db().rpc('billing_reserve_usage', {
        p_workspace: workspaceId, p_metric: metric, p_quantity: quantity, p_limit: limit,
        p_period_start: periodStart, p_period_end: periodEnd, p_key: key, p_ttl_seconds: ttlSeconds,
      })));
      return { reservationId: r.reservation_id, allowed: r.allowed, replayed: r.replayed, used: Number(r.used), reserved: Number(r.reserved) };
    },
    async recordUsage({ workspaceId, metric, quantity, key, source = null, sourceId = null, actorId = null, reservationId = null }) {
      return unwrap(await db().rpc('billing_record_usage', {
        p_workspace: workspaceId, p_metric: metric, p_quantity: quantity, p_key: key,
        p_source: source, p_source_id: sourceId, p_actor: actorId, p_reservation: reservationId,
      })) === true;
    },
    async releaseReservation(workspaceId, reservationId) {
      return unwrap(await db().rpc('billing_release_reservation', { p_workspace: workspaceId, p_reservation: reservationId })) === true;
    },
    async usageTotals(workspaceId, from, to) {
      const rows = unwrap(await db().rpc('billing_usage_totals', { p_workspace: workspaceId, p_from: from, p_to: to }));
      return Object.fromEntries((rows || []).map((r) => [r.metric, Number(r.total)]));
    },
    async usageDaily(workspaceId, from, to) {
      const rows = unwrap(await db().rpc('billing_usage_daily', { p_workspace: workspaceId, p_from: from, p_to: to }));
      return (rows || []).map((r) => ({ day: String(r.day).slice(0, 10), metric: r.metric, total: Number(r.total) }));
    },

    /** true = first delivery; false = duplicate (provider, event_id). */
    async insertWebhookEvent(row) {
      const { error } = await db().from('billing_webhook_events').insert(row);
      if (error && error.code === '23505') return false;
      unwrap({ data: null, error });
      return true;
    },
    async updateWebhookEvent(provider, eventId, patch) {
      unwrap(await db().from('billing_webhook_events').update(patch).eq('provider', provider).eq('event_id', eventId));
    },
    /** Forget a delivery whose processing failed, so the provider's retry is processed. */
    async deleteWebhookEvent(provider, eventId) {
      unwrap(await db().from('billing_webhook_events').delete().eq('provider', provider).eq('event_id', eventId));
    },

    // ---- Layer 8 (migrations/20260930_layer8_customer.up.sql) ----
    async getCustomerBinding(workspaceId, provider) {
      return first(unwrap(await db().from('billing_customers').select('*').eq('workspace_id', workspaceId).eq('provider', provider).limit(1)));
    },
    async findCustomerBinding(provider, externalCustomerId) {
      return first(unwrap(await db().from('billing_customers').select('*').eq('provider', provider).eq('external_customer_id', externalCustomerId).limit(1)));
    },
    /** Returns the row, or null when the workspace or the customer is already bound. */
    async insertCustomerBinding(row) {
      const { data, error } = await db().from('billing_customers').insert(row).select('*');
      if (error && error.code === '23505') return null;
      return first(unwrap({ data, error }));
    },
    async insertCheckoutSession(row) {
      return first(unwrap(await db().from('billing_checkout_sessions').insert(row).select('*')));
    },
    async getCheckoutSession(provider, externalSessionId) {
      return first(unwrap(await db().from('billing_checkout_sessions').select('*').eq('provider', provider).eq('external_session_id', externalSessionId).limit(1)));
    },
    /** CAS on status. Returns the row, or null when it was not in fromStatus. */
    async updateCheckoutSession(provider, externalSessionId, fromStatus, patch) {
      return first(unwrap(await db().from('billing_checkout_sessions').update(patch)
        .eq('provider', provider).eq('external_session_id', externalSessionId).eq('status', fromStatus).select('*')));
    },
    async listPlanFeatures() {
      return unwrap(await db().from('billing_plan_features').select('plan_id, features'));
    },
    async getPlanOverride(workspaceId) {
      const { data, error } = await db().from('workspace_plan_overrides').select('*').eq('workspace_id', workspaceId).limit(1);
      // Deployments without the Layer 8 migration have no overrides.
      if (error && (error.code === '42P01' || error.code === 'PGRST205')) return null;
      return first(unwrap({ data, error }));
    },
    async setPlanOverride(workspaceId, row) {
      if (row === null) {
        unwrap(await db().from('workspace_plan_overrides').delete().eq('workspace_id', workspaceId));
        return null;
      }
      return first(unwrap(await db().from('workspace_plan_overrides')
        .upsert({ ...row, workspace_id: workspaceId, updated_at: nowIso() }, { onConflict: 'workspace_id' }).select('*')));
    },
  };
}

module.exports = { createSupabaseBillingStore };
