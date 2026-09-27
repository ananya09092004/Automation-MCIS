/**
 * Layer 8 — Supabase persistence for user_onboarding
 * (migrations/20260930_layer8_customer.up.sql). One row per user; every
 * update is a compare-and-swap on `version`.
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

function createSupabaseOnboardingStore() {
  return {
    async getOnboarding(userId) {
      return first(unwrap(await db().from('user_onboarding').select('*').eq('user_id', userId).limit(1)));
    },
    /** Returns the row, or null if one already exists (concurrent start). */
    async insertOnboarding(row) {
      const { data, error } = await db().from('user_onboarding').insert({ ...row, version: 1 }).select('*');
      if (error && error.code === '23505') return null;
      return first(unwrap({ data, error }));
    },
    /** CAS: returns the updated row, or null when the version moved on. */
    async updateOnboarding(userId, expectedVersion, patch) {
      return first(unwrap(await db().from('user_onboarding')
        .update({ ...patch, version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('version', expectedVersion).select('*')));
    },
  };
}

module.exports = { createSupabaseOnboardingStore };
