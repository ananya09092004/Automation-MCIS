/**
 * Layer 10 — invitation emails (closes L1-4 / L8-4).
 *
 * Optional: configured only when INVITE_EMAIL_PROVIDER (resend | sendgrid),
 * INVITE_EMAIL_API_KEY, INVITE_EMAIL_FROM and APP_BASE_URL are set. The
 * email carries a link whose one-time code is in the URL FRAGMENT
 * (#invite=…), so it never reaches a server log. The result is reported
 * honestly: `sent` only when the provider accepted the message (2xx);
 * otherwise `failed` with a code — the invitation itself (and its one-time
 * code shown to the admin) stays valid either way. The API key is never
 * returned or logged.
 */
'use strict';

const PROVIDERS = {
  resend: { url: 'https://api.resend.com/emails', host: 'api.resend.com' },
  sendgrid: { url: 'https://api.sendgrid.com/v3/mail/send', host: 'api.sendgrid.com' },
};
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mailerConfig(env = process.env) {
  const provider = String(env.INVITE_EMAIL_PROVIDER || '').toLowerCase();
  if (!provider) return { configured: false, reason: 'INVITE_EMAIL_PROVIDER not set' };
  if (!PROVIDERS[provider]) return { configured: false, error: 'INVITE_EMAIL_PROVIDER must be resend or sendgrid' };
  if (!env.INVITE_EMAIL_API_KEY || !/^[A-Za-z0-9._-]{16,300}$/.test(env.INVITE_EMAIL_API_KEY)) return { configured: false, error: 'INVITE_EMAIL_API_KEY is missing or malformed' };
  if (!EMAIL_RE.test(String(env.INVITE_EMAIL_FROM || ''))) return { configured: false, error: 'INVITE_EMAIL_FROM must be a sender address verified with the provider' };
  let base;
  try { base = new URL(String(env.APP_BASE_URL || '')); } catch { return { configured: false, error: 'APP_BASE_URL must be the web app URL' }; }
  return { configured: true, provider, from: env.INVITE_EMAIL_FROM, appBaseUrl: base.origin, apiKey: env.INVITE_EMAIL_API_KEY };
}

function createInvitationMailer({ http, env = process.env, endpoints = null, logger = console } = {}) {
  const cfg = mailerConfig(env);
  if (cfg.error) logger.warn?.(`Invitations: email disabled (${cfg.error})`);
  const target = cfg.configured ? (endpoints && endpoints[cfg.provider]) || PROVIDERS[cfg.provider] : null;
  return {
    configured: !!cfg.configured,
    async send({ to, workspaceName, role, token, invitationId }) {
      if (!cfg.configured || !http) return { status: 'not_configured' };
      const link = `${cfg.appBaseUrl}/workspace#invite=${encodeURIComponent(token)}`;
      const subject = `You're invited to ${String(workspaceName).slice(0, 80)} on Nexus`;
      const text = `You have been invited to join the workspace "${workspaceName}" as ${role}.\n\nOpen this link while signed in with this email address:\n${link}\n\nOr paste this one-time code in Workspace → Join: ${token}\n\nThe invitation expires in 7 days. If you did not expect it, ignore this email.`;
      const html = `<p>You have been invited to join the workspace <strong>${esc(workspaceName)}</strong> as ${esc(role)}.</p><p><a href="${esc(link)}">Accept the invitation</a> (sign in with this email address).</p><p>The invitation expires in 7 days. If you did not expect it, ignore this email.</p>`;
      const body = cfg.provider === 'resend'
        ? { from: cfg.from, to: [to], subject, text, html }
        : { personalizations: [{ to: [{ email: to }] }], from: { email: cfg.from }, subject, content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }] };
      try {
        const res = await http.request({
          url: target.url, method: 'POST', allowedMethods: ['POST'], allowedHosts: [target.host || new URL(target.url).hostname],
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', ...(cfg.provider === 'resend' && invitationId ? { 'Idempotency-Key': `invite-${invitationId}` } : {}) },
          body: JSON.stringify(body), timeoutMs: 10000, maxBytes: 16 * 1024, maxRedirects: 0,
        });
        if (res.status >= 200 && res.status < 300) return { status: 'sent', provider: cfg.provider };
        return { status: 'failed', code: res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : `HTTP_${res.status}` };
      } catch (err) {
        return { status: 'failed', code: String(err.code || 'NETWORK_ERROR').slice(0, 40) };
      }
    },
  };
}

module.exports = { createInvitationMailer, mailerConfig };
