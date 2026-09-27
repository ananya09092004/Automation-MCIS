/**
 * Layer 10 — Slack connector (provider "slack") via an Incoming Webhook.
 *
 * Credential (encrypted by Layer 5): { webhookUrl } — a Slack Incoming
 * Webhook URL (https://hooks.slack.com/services/…). The webhook is bound by
 * Slack to ONE channel chosen by the workspace admin when it was created, so
 * a message can never be redirected to another channel or workspace.
 *
 * Actions          risk    default    retry
 *   notify         GREEN   enabled    never (not idempotent)   alert-style message (title, text, severity, link)
 *   post_message   YELLOW  disabled   never                    free text written by an agent step
 *
 * Every call goes through the gateway (Agent Firewall ticket, action
 * enablement, role) and the SSRF-safe client (only hooks.slack.com).
 */
'use strict';

const { validateInput, InputError, ConnectorError } = require('./schema');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const HOOK_HOST = 'hooks.slack.com';
const bad = (m) => { throw new InputError(m); };

function validateConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  for (const k of Object.keys(raw)) if (!['channelLabel'].includes(k)) bad(`unknown config "${k}"`);
  if (raw.channelLabel !== undefined && (typeof raw.channelLabel !== 'string' || raw.channelLabel.length > 80)) bad('config.channelLabel must be a short label such as #pricing-alerts');
  return { channelLabel: raw.channelLabel ? raw.channelLabel.trim() : null };
}

const ACTIONS = {
  notify: {
    label: 'Send alert', description: 'Post an alert (title, text, severity, link) to the webhook\'s channel.',
    risk: 'green', readOnly: false, defaultEnabled: true, permission: 'slack:notify',
    fields: {
      title: { type: 'string', required: true, maxLength: 200 },
      text: { type: 'string', required: true, maxLength: 3000 },
      severity: { type: 'enum', options: ['info', 'warning', 'critical'], default: 'info' },
      link: { type: 'string', maxLength: 500, pattern: /^https:\/\/[^\s]+$/ },
    },
    output: '{ delivered }',
  },
  post_message: {
    label: 'Post message', description: 'Post free text to the webhook\'s channel.',
    risk: 'yellow', readOnly: false, defaultEnabled: false, permission: 'slack:write',
    fields: { text: { type: 'string', required: true, maxLength: 3000 } },
    output: '{ delivered }',
  },
};
for (const a of Object.values(ACTIONS)) {
  a.safeToRepeat = () => false;
  a.timeoutMs = 10000;
  a.retry = 'Never retried automatically (a repeat would post twice).';
}

const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

/** `webhookHost` is a TEST SEAM (local Slack double); production uses hooks.slack.com. */
function createSlackConnector({ webhookHost = HOOK_HOST, allowInsecureHttpForTests = false } = {}) {
  function validateCredential(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.webhookUrl !== 'string') bad('credentials.webhookUrl is required');
    for (const k of Object.keys(raw)) if (k !== 'webhookUrl') bad(`unknown credential field "${k}"`);
    let u;
    try { u = new URL(raw.webhookUrl.trim()); } catch { bad('credentials.webhookUrl must be a Slack Incoming Webhook URL'); }
    const schemeOk = u.protocol === 'https:' || (allowInsecureHttpForTests && u.protocol === 'http:');
    if (!schemeOk || u.hostname !== webhookHost || !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(u.pathname) || u.search || u.username) {
      bad('credentials.webhookUrl must be a Slack Incoming Webhook URL (https://hooks.slack.com/services/…)');
    }
    return { webhookUrl: u.toString() };
  }
  return {
    provider: 'slack',
    displayName: 'Slack (incoming webhook)',
    description: 'Send alerts and (optionally) agent messages to one Slack channel.',
    credentialFields: [{ name: 'webhookUrl', label: 'Incoming Webhook URL', secret: true }],
    actions: ACTIONS,
    validateConfig,
    validateCredential,
    requiresCredential: () => true,
    connect({ config, credential }) { return { config: validateConfig(config), credential: validateCredential(credential) }; },
    disconnect() { /* revoke the webhook in Slack; we delete our encrypted copy */ },
    validateAction(action, input) {
      const a = ACTIONS[action];
      if (!a) throw new InputError(`Action "${action}" is not available for this integration`);
      return validateInput(a.fields, input);
    },
    describeTarget(action, input, config) { return `slack:${config.channelLabel || 'webhook channel'}`; },
    async healthCheck({ credential }) {
      // Posting a test message would be a side effect; a valid stored URL is all we can check.
      validateCredential(credential);
      return { ok: true, detail: 'webhook URL stored; delivery is confirmed on first message' };
    },
    async execute({ action, input, credential, http }) {
      const text = action === 'notify'
        ? `${ICON[input.severity] || ''} *${input.title}*\n${input.text}${input.link ? `\n<${input.link}|Open in Nexus>` : ''}`
        : input.text;
      let res;
      try {
        res = await http.request({
          url: credential.webhookUrl, method: 'POST', allowedMethods: ['POST'], allowedHosts: [webhookHost],
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'nexus-integrations' },
          body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
          timeoutMs: 10000, maxBytes: 16 * 1024, maxRedirects: 0,
        });
      } catch (err) {
        throw new ConnectorError(err.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR', 'Could not reach Slack', { retryable: false });
      }
      if (res.status === 200) return { data: { delivered: true }, summary: 'Message delivered to Slack', verified: true };
      if (res.status === 404 || res.status === 403 || res.status === 410) throw new ConnectorError('AUTH_FAILED', `Slack rejected the webhook (HTTP ${res.status}); it may have been revoked`, { authFailed: true });
      if (res.status === 429) throw new ConnectorError('RATE_LIMITED', 'Slack rate limit reached', { retryable: true });
      if (res.status >= 500) throw new ConnectorError('PROVIDER_ERROR', `Slack returned HTTP ${res.status}`, { retryable: true });
      throw new ConnectorError(`HTTP_${res.status}`, `Slack returned HTTP ${res.status}`);
    },
    redactResult(data) { return redact(data); },
  };
}

module.exports = { createSlackConnector, HOOK_HOST };
