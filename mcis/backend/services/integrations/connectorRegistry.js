/**
 * Layer 5 — connector registry.
 *
 * Connector contract (all implemented by each connector module):
 *   provider, displayName, description, credentialFields, actions{}
 *   validateConfig(raw) → normalized non-secret config
 *   validateCredential(raw, config) → normalized secret (or null)
 *   requiresCredential(config) → boolean
 *   connect({config, credential}) / disconnect()
 *   healthCheck({config, credential, http})
 *   validateAction(action, input, config) → normalized input (throws)
 *   describeTarget(action, input, config) → safe resource identifier
 *   execute({action, input, config, credential, http, idempotencyKey}) → {data, summary, verified}
 *   redactResult(data) → safe data
 *
 * Action descriptor: label, description, risk (green|yellow|red), readOnly,
 *   safeToRepeat(config), defaultEnabled, permission, fields, output,
 *   timeoutMs, retry, available?(config)
 *
 * Connectors never touch the database or the credential store: they get
 * a decrypted credential only as an argument of execute/healthCheck.
 */
'use strict';

const { describeFields } = require('./connectors/schema');

function createConnectorRegistry(connectors) {
  const map = new Map();
  for (const c of connectors) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(c.provider)) throw new Error(`invalid provider id ${c.provider}`);
    if (map.has(c.provider)) throw new Error(`duplicate connector ${c.provider}`);
    for (const [name, a] of Object.entries(c.actions)) {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error(`invalid action ${c.provider}.${name}`);
      if (!['green', 'yellow', 'red'].includes(a.risk)) throw new Error(`action ${c.provider}.${name} has no valid risk tier`);
      if (typeof a.safeToRepeat !== 'function') throw new Error(`action ${c.provider}.${name} must declare safeToRepeat`);
    }
    map.set(c.provider, c);
  }

  function describe(c) {
    return {
      provider: c.provider,
      displayName: c.displayName,
      description: c.description,
      credentialFields: c.credentialFields.map((f) => ({ name: f.name, label: f.label, secret: !!f.secret })),
      actions: Object.entries(c.actions).map(([name, a]) => ({
        name,
        qualifiedName: `${c.provider}.${name}`,
        label: a.label,
        description: a.description,
        risk: a.risk,
        readOnly: !!a.readOnly,
        requiresApproval: a.risk !== 'green',
        requiresAdminApproval: a.risk === 'red',
        defaultEnabled: !!a.defaultEnabled,
        permission: a.permission,
        input: describeFields(a.fields),
        output: a.output,
        timeoutMs: a.timeoutMs,
        retry: a.retry,
      })),
    };
  }

  return {
    get: (provider) => map.get(provider) || null,
    list: () => [...map.values()].map(describe),
    describe: (provider) => (map.has(provider) ? describe(map.get(provider)) : null),
    // Actions that are safe to repeat regardless of configuration — used
    // by the Layer 4 recovery rules (qualified names as recorded in evidence).
    staticallySafeActionNames() {
      const out = [];
      for (const c of map.values()) {
        for (const [name, a] of Object.entries(c.actions)) if (a.readOnly) out.push(`${c.provider}.${name}`);
      }
      return out;
    },
  };
}

function createDefaultRegistry() {
  const { createHttpApiConnector } = require('./connectors/httpApiConnector');
  const { createGithubConnector } = require('./connectors/githubConnector');
  // Layer 9: expiring GitHub App user tokens are refreshed with the OAuth app credentials.
  const oauthRefresh = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } : null;
  const connectors = [createHttpApiConnector(), createGithubConnector({ oauthRefresh })];
  // Layer 10: read-only web pages (monitoring), Slack and email alert channels.
  const { createWebPageConnector } = require('./connectors/webPageConnector');
  const { createSlackConnector } = require('./connectors/slackConnector');
  const { createEmailConnector } = require('./connectors/emailConnector');
  connectors.push(createWebPageConnector(), createSlackConnector(), createEmailConnector());
  // Layer 9: read-only Google Drive, only when explicitly enabled.
  if (String(process.env.GOOGLE_DRIVE_ENABLED || '').toLowerCase() === 'true') {
    const { createGoogleDriveConnector } = require('./connectors/googleDriveConnector');
    const oauth = process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      ? { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : null;
    connectors.push(createGoogleDriveConnector({ oauth }));
  }
  return createConnectorRegistry(connectors);
}

module.exports = { createConnectorRegistry, createDefaultRegistry };
