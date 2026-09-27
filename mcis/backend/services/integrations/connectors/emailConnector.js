/**
 * Layer 10 — email connector (provider "email") over a transactional email
 * provider's HTTPS API: Resend (api.resend.com) or SendGrid (api.sendgrid.com).
 *
 * Config (non-secret): provider, from (a sender address verified with the
 *   provider), alertRecipients (fixed list used by `notify`),
 *   allowedRecipientDomains (the only domains `send_email` may address).
 * Credential (encrypted): { token } — the provider API key.
 *
 * Actions        risk    default    recipients
 *   notify       GREEN   enabled    config.alertRecipients only (fixed by an admin)
 *   send_email   YELLOW  disabled   one address in allowedRecipientDomains
 * Neither is retried automatically (a retry could send twice).
 */
'use strict';

const { validateInput, InputError, ConnectorError } = require('./schema');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const PROVIDERS = Object.freeze({
  resend: { host: 'api.resend.com', path: '/emails' },
  sendgrid: { host: 'api.sendgrid.com', path: '/v3/mail/send' },
});
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$/;
const DOMAIN_RE = /^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const bad = (m) => { throw new InputError(m); };

function validateConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  for (const k of Object.keys(raw)) if (!['provider', 'from', 'alertRecipients', 'allowedRecipientDomains'].includes(k)) bad(`unknown config "${k}"`);
  if (!PROVIDERS[raw.provider]) bad(`config.provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (typeof raw.from !== 'string' || !EMAIL_RE.test(raw.from.trim())) bad('config.from must be a sender email address verified with the provider');
  const rec = raw.alertRecipients === undefined ? [] : raw.alertRecipients;
  if (!Array.isArray(rec) || rec.length > 20 || rec.some((r) => typeof r !== 'string' || !EMAIL_RE.test(r.trim()))) bad('config.alertRecipients must list at most 20 email addresses');
  const dom = raw.allowedRecipientDomains === undefined ? [] : raw.allowedRecipientDomains;
  if (!Array.isArray(dom) || dom.length > 20 || dom.some((d) => typeof d !== 'string' || !DOMAIN_RE.test(d.trim().toLowerCase()))) bad('config.allowedRecipientDomains must list at most 20 domains');
  return {
    provider: raw.provider,
    from: raw.from.trim(),
    alertRecipients: [...new Set(rec.map((r) => r.trim().toLowerCase()))],
    allowedRecipientDomains: [...new Set(dom.map((d) => d.trim().toLowerCase()))],
  };
}

function validateCredential(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || !/^[A-Za-z0-9._-]{16,300}$/.test(raw.token.trim())) bad('credentials.token must be the provider API key');
  for (const k of Object.keys(raw)) if (k !== 'token') bad(`unknown credential field "${k}"`);
  return { token: raw.token.trim() };
}

const ACTIONS = {
  notify: {
    label: 'Send alert email', description: 'Email the workspace\'s fixed alert recipients.',
    risk: 'green', readOnly: false, defaultEnabled: true, permission: 'email:notify',
    available: (config) => config.alertRecipients.length > 0,
    fields: { subject: { type: 'string', required: true, maxLength: 200 }, text: { type: 'string', required: true, maxLength: 10000 } },
    output: '{ messageId }',
  },
  send_email: {
    label: 'Send email', description: 'Send one email to an address in an allowed domain.',
    risk: 'yellow', readOnly: false, defaultEnabled: false, permission: 'email:send',
    available: (config) => config.allowedRecipientDomains.length > 0,
    fields: {
      to: { type: 'string', required: true, maxLength: 254, pattern: EMAIL_RE },
      subject: { type: 'string', required: true, maxLength: 200 },
      text: { type: 'string', required: true, maxLength: 10000 },
    },
    output: '{ messageId }',
  },
};
for (const a of Object.values(ACTIONS)) {
  a.safeToRepeat = () => false;
  a.timeoutMs = 15000;
  a.retry = 'Never retried automatically (a repeat could send twice).';
}

/** `apiBases` is a TEST SEAM ({ resend, sendgrid } base URLs); production uses the providers' hosts. */
function createEmailConnector({ apiBases = null } = {}) {
  const endpoint = (provider) => {
    const p = PROVIDERS[provider];
    const base = apiBases && apiBases[provider] ? apiBases[provider].replace(/\/$/, '') : `https://${p.host}`;
    return { url: `${base}${p.path}`, host: new URL(base).hostname };
  };
  return {
    provider: 'email',
    displayName: 'Email (Resend / SendGrid)',
    description: 'Send alert emails to fixed recipients and, if enabled, emails to approved domains.',
    credentialFields: [{ name: 'token', label: 'Provider API key', secret: true }],
    actions: ACTIONS,
    validateConfig,
    validateCredential,
    requiresCredential: () => true,
    connect({ config, credential }) { return { config: validateConfig(config), credential: validateCredential(credential) }; },
    disconnect() {},
    validateAction(action, input, config) {
      const a = ACTIONS[action];
      if (!a || (a.available && !a.available(config))) throw new InputError(`Action "${action}" is not available for this integration`);
      const v = validateInput(a.fields, input);
      if (action === 'send_email') {
        const domain = v.to.split('@')[1].toLowerCase();
        if (!config.allowedRecipientDomains.includes(domain)) throw new InputError(`Recipient domain ${domain} is not allowed for this integration`);
      }
      return v;
    },
    describeTarget(action, input, config) {
      return action === 'notify' ? `email:${config.alertRecipients.length} alert recipient(s)` : `email:${String(input.to).split('@')[1]}`;
    },
    async healthCheck({ config }) { return { ok: true, detail: `${config.provider} key stored; delivery is confirmed per message` }; },
    async execute({ action, input, config, credential, http, idempotencyKey }) {
      const to = action === 'notify' ? config.alertRecipients : [input.to];
      const { url, host } = endpoint(config.provider);
      const body = config.provider === 'resend'
        ? { from: config.from, to, subject: input.subject, text: input.text }
        : { personalizations: [{ to: to.map((email) => ({ email })) }], from: { email: config.from }, subject: input.subject, content: [{ type: 'text/plain', value: input.text }] };
      const headers = { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'nexus-integrations' };
      if (config.provider === 'resend' && idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      let res;
      try {
        res = await http.request({ url, method: 'POST', allowedMethods: ['POST'], allowedHosts: [host], headers, body: JSON.stringify(body), timeoutMs: 15000, maxBytes: 32 * 1024, maxRedirects: 0 });
      } catch (err) {
        throw new ConnectorError(err.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR', 'Could not reach the email provider');
      }
      if (res.status === 401 || res.status === 403) throw new ConnectorError('AUTH_FAILED', `The email provider rejected the API key (HTTP ${res.status})`, { authFailed: res.status === 401 });
      if (res.status === 429) throw new ConnectorError('RATE_LIMITED', 'The email provider rate limit was reached', { retryable: true });
      if (res.status >= 500) throw new ConnectorError('PROVIDER_ERROR', `The email provider returned HTTP ${res.status}`, { retryable: true });
      if (res.status < 200 || res.status >= 300) throw new ConnectorError(`HTTP_${res.status}`, `The email provider refused the message (HTTP ${res.status})`);
      let messageId = null;
      try { const j = JSON.parse(res.body || '{}'); messageId = typeof j.id === 'string' ? j.id.slice(0, 100) : null; } catch { messageId = null; }
      if (!messageId && res.headers && res.headers['x-message-id']) messageId = String(res.headers['x-message-id']).slice(0, 100);
      return { data: { messageId, recipients: to.length }, summary: `Email accepted by ${config.provider} for ${to.length} recipient(s)`, verified: true };
    },
    redactResult(data) { return redact(data); },
  };
}

module.exports = { createEmailConnector, PROVIDERS };
