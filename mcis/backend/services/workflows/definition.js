/**
 * Layer 4 — workflow definition validation + the (deliberately tiny)
 * template language.
 *
 * Definition (stored in workflows.draft, snapshotted into
 * workflow_versions.definition on publish):
 *
 *   {
 *     variables: [{ name, label?, type: string|number|boolean|date|enum,
 *                   required?, default?, options? (enum), maxLength? }],
 *     steps: [{ key, name, instruction, expectedOutput?,
 *               approval: auto|required|admin,
 *               verification: best_effort|required,
 *               retry: { maxAttempts: 0..3 },
 *               timeoutMinutes: 1..120 }],
 *     policy: { maxRunMinutes: 1..1440 }
 *   }
 *
 *   Layer 6: a step may declare typed structured outputs
 *     outputs: [{ name, type: string|number|boolean|object|array, required? }]
 *   referenced later as {{steps.<key>.outputs.<name>}}. Values are
 *   validated (type, size, no prototype keys, secrets redacted) by the
 *   runner BEFORE a later step can see them; see validateStructuredOutputs.
 *
 * Templates: ONLY `{{input.<variable>}}`, `{{steps.<earlier_key>.output}}`
 * and `{{steps.<earlier_key>.outputs.<name>}}`.
 * No expressions, filters, function calls, property walking or eval. The
 * renderer does a single pass: substituted values are never re-scanned, so
 * a value that itself contains "{{…}}" is rendered literally (no template
 * injection). Any other `{{` sequence is rejected at save/publish time.
 *
 * Secrets: input values are passed through the existing
 * sensitiveDataFilter BEFORE they are stored, so a secret can never be
 * rendered into an instruction, a log, evidence or the database.
 */
'use strict';

const crypto = require('crypto');
// Layer 6: sensitive-data classifier (superset of sensitiveDataFilter).
const { sanitizeString } = require('../security/sensitiveClassifier');

const redactString = (v, max) => sanitizeString(v, max);

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const VAR_TYPES = ['string', 'number', 'boolean', 'date', 'enum'];
const APPROVALS = ['auto', 'required', 'admin'];
const VERIFICATIONS = ['best_effort', 'required'];
const LIMITS = Object.freeze({
  variables: 30, steps: 20, instruction: 2000, expectedOutput: 1000, stepName: 120,
  label: 120, value: 2000, enumOptions: 50, renderedGoal: 4000, stepOutput: 1000,
  outputs: 10, structuredOutputBytes: 16 * 1024, renderedOutputValue: 2000,
});
// Layer 9: 'table' ({ columns, rows }) and 'artifact' (a reference, never file content).
const OUTPUT_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'table', 'artifact'];
const ARTIFACT_KINDS = ['file', 'url', 'document', 'image', 'dataset'];
const TABLE_LIMITS = Object.freeze({ columns: 50, rows: 1000, columnName: 64 });

/** Layer 9: { columns: [names], rows: [[cell…]] } with scalar cells, bounded. */
function isTable(v) {
  if (!isPlainObject(v) || !Array.isArray(v.columns) || !Array.isArray(v.rows)) return false;
  if (Object.keys(v).some((k) => k !== 'columns' && k !== 'rows')) return false;
  const c = v.columns;
  if (!c.length || c.length > TABLE_LIMITS.columns) return false;
  if (c.some((n) => typeof n !== 'string' || !n.trim() || n.length > TABLE_LIMITS.columnName) || new Set(c).size !== c.length) return false;
  if (v.rows.length > TABLE_LIMITS.rows) return false;
  return v.rows.every((r) => Array.isArray(r) && r.length === c.length
    && r.every((x) => x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))));
}

/** Layer 9: a reference to something produced elsewhere — https URL or opaque id; no credentials in URLs. */
function isArtifactRef(v) {
  if (!isPlainObject(v)) return false;
  if (Object.keys(v).some((k) => !['kind', 'name', 'ref', 'mimeType', 'size'].includes(k))) return false;
  if (!ARTIFACT_KINDS.includes(v.kind)) return false;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200) return false;
  if (typeof v.ref !== 'string' || !v.ref || v.ref.length > 500) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v.ref)) {
    let u;
    try { u = new URL(v.ref); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
  } else if (!/^[A-Za-z0-9._:/-]+$/.test(v.ref) || /(^|\/)\.\.(\/|$)/.test(v.ref)) return false;
  if (v.mimeType !== undefined && (typeof v.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(v.mimeType))) return false;
  if (v.size !== undefined && !(Number.isInteger(v.size) && v.size >= 0 && v.size <= 1e13)) return false;
  return true;
}
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// A placeholder is exactly {{ input.x }}, {{ steps.x.output }} or
// {{ steps.x.outputs.y }} (spaces allowed).
const PLACEHOLDER_RE = /\{\{\s*(input\.([a-z][a-z0-9_]{0,63})|steps\.([a-z][a-z0-9_]{0,63})\.output(?:s\.([a-z][a-z0-9_]{0,63}))?)\s*\}\}/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class DefinitionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DefinitionError';
    this.status = 400;
    this.code = 'INVALID_WORKFLOW';
    if (details) this.extra = { details };
  }
}

const bad = (msg) => { throw new DefinitionError(msg); };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v, field, { min = 0, max, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    v = '';
  }
  if (typeof v !== 'string') bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) bad(`${field} must be ${min}-${max} characters`);
  return t;
}

/** Returns every placeholder reference, and rejects any stray "{{" / "}}". */
function parseTemplate(text, field) {
  const refs = [];
  const stripped = text.replace(PLACEHOLDER_RE, (m, _whole, input, step, output) => {
    refs.push(input ? { kind: 'input', name: input } : { kind: 'step', key: step, output: output || null });
    return '';
  });
  if (stripped.includes('{{') || stripped.includes('}}')) {
    bad(`${field} contains an unsupported template expression; only {{input.<name>}}, {{steps.<key>.output}} and {{steps.<key>.outputs.<name>}} are allowed`);
  }
  return refs;
}

function normalizeVariable(v, i) {
  if (!isPlainObject(v)) bad(`variables[${i}] must be an object`);
  const name = str(v.name, `variables[${i}].name`, { min: 1, max: 64 });
  if (!NAME_RE.test(name)) bad(`variables[${i}].name must match ${NAME_RE}`);
  const type = v.type === undefined ? 'string' : v.type;
  if (!VAR_TYPES.includes(type)) bad(`variables[${i}].type must be one of ${VAR_TYPES.join(', ')}`);
  const out = {
    name,
    label: str(v.label, `variables[${i}].label`, { max: LIMITS.label, optional: true }) || name,
    type,
    required: v.required === undefined ? true : v.required === true,
  };
  if (type === 'string') {
    const maxLength = v.maxLength === undefined ? 500 : v.maxLength;
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > LIMITS.value) bad(`variables[${i}].maxLength must be 1-${LIMITS.value}`);
    out.maxLength = maxLength;
  }
  if (type === 'enum') {
    if (!Array.isArray(v.options) || !v.options.length || v.options.length > LIMITS.enumOptions) {
      bad(`variables[${i}].options must be 1-${LIMITS.enumOptions} strings`);
    }
    out.options = v.options.map((o, j) => str(o, `variables[${i}].options[${j}]`, { min: 1, max: 200 }));
    if (new Set(out.options).size !== out.options.length) bad(`variables[${i}].options must be unique`);
  }
  if (v.default !== undefined && v.default !== null) {
    out.default = coerceValue(out, v.default, `variables[${i}].default`);
  }
  return out;
}

// Layer 5: a step may run ONE integration action instead of the planner.
// It references the integration by id — never a credential. Input values
// are strings (templates allowed), numbers or booleans.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeConnector(c, i) {
  if (c === undefined || c === null) return null;
  if (!isPlainObject(c)) bad(`steps[${i}].connector must be an object`);
  for (const k of Object.keys(c)) if (!['integrationId', 'action', 'input'].includes(k)) bad(`steps[${i}].connector has unknown field "${k}"`);
  if (typeof c.integrationId !== 'string' || !UUID_RE.test(c.integrationId)) bad(`steps[${i}].connector.integrationId must be an integration id`);
  if (typeof c.action !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(c.action)) bad(`steps[${i}].connector.action is invalid`);
  const input = c.input === undefined ? {} : c.input;
  if (!isPlainObject(input) || Object.keys(input).length > 20) bad(`steps[${i}].connector.input must be an object with at most 20 fields`);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) bad(`steps[${i}].connector.input has an invalid field name "${k}"`);
    if (typeof v === 'string') {
      if (v.length > LIMITS.instruction) bad(`steps[${i}].connector.input.${k} is too long`);
      out[k] = redactString(v, LIMITS.instruction);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (isPlainObject(v)) {
      // Layer 10: ONE level of named scalars (e.g. a POST body, query or
      // headers); strings may use templates like any other input.
      if (Object.keys(v).length > 20) bad(`steps[${i}].connector.input.${k} may have at most 20 fields`);
      const o = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(kk)) bad(`steps[${i}].connector.input.${k} has an invalid field name "${kk}"`);
        if (typeof vv === 'string') {
          if (vv.length > LIMITS.instruction) bad(`steps[${i}].connector.input.${k}.${kk} is too long`);
          o[kk] = redactString(vv, LIMITS.instruction);
        } else if (typeof vv === 'number' || typeof vv === 'boolean' || vv === null) o[kk] = vv;
        else bad(`steps[${i}].connector.input.${k}.${kk} must be a string, number, boolean or null`);
      }
      out[k] = o;
    } else {
      bad(`steps[${i}].connector.input.${k} must be a string, number, boolean or an object of those`);
    }
  }
  return { integrationId: c.integrationId.toLowerCase(), action: c.action, input: out };
}

function normalizeOutputs(o, i, isConnector) {
  if (o === undefined || o === null) return null;
  if (!Array.isArray(o) || !o.length || o.length > LIMITS.outputs) bad(`steps[${i}].outputs must be an array of 1-${LIMITS.outputs} outputs`);
  const names = new Set();
  return o.map((x, j) => {
    if (!isPlainObject(x)) bad(`steps[${i}].outputs[${j}] must be an object`);
    for (const k of Object.keys(x)) if (!['name', 'type', 'required'].includes(k)) bad(`steps[${i}].outputs[${j}] has unknown field "${k}"`);
    if (typeof x.name !== 'string' || !NAME_RE.test(x.name)) bad(`steps[${i}].outputs[${j}].name must match ${NAME_RE}`);
    if (names.has(x.name)) bad(`steps[${i}].outputs has duplicate name "${x.name}"`);
    names.add(x.name);
    if (!OUTPUT_TYPES.includes(x.type)) bad(`steps[${i}].outputs[${j}].type must be one of ${OUTPUT_TYPES.join(', ')}`);
    if (x.required !== undefined && typeof x.required !== 'boolean') bad(`steps[${i}].outputs[${j}].required must be boolean`);
    // An agent (planner) step produces text only: its one structured output is its summary.
    if (!isConnector && (x.name !== 'summary' || x.type !== 'string')) bad(`steps[${i}].outputs: an agent step can only declare { name: "summary", type: "string" }`);
    return { name: x.name, type: x.type, required: x.required !== false };
  });
}

function normalizeStep(s, i) {
  if (!isPlainObject(s)) bad(`steps[${i}] must be an object`);
  const key = str(s.key, `steps[${i}].key`, { min: 1, max: 64 });
  if (!NAME_RE.test(key)) bad(`steps[${i}].key must match ${NAME_RE}`);
  const approval = s.approval === undefined ? 'auto' : s.approval;
  if (!APPROVALS.includes(approval)) bad(`steps[${i}].approval must be one of ${APPROVALS.join(', ')}`);
  const verification = s.verification === undefined ? 'best_effort' : s.verification;
  if (!VERIFICATIONS.includes(verification)) bad(`steps[${i}].verification must be one of ${VERIFICATIONS.join(', ')}`);
  const maxAttempts = s.retry === undefined || s.retry === null || s.retry.maxAttempts === undefined ? 1 : s.retry.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 3) bad(`steps[${i}].retry.maxAttempts must be 0-3`);
  const timeoutMinutes = s.timeoutMinutes === undefined ? 30 : s.timeoutMinutes;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) bad(`steps[${i}].timeoutMinutes must be 1-120`);
  // Layer 10: step type ('agent' default | 'review' = a human reviewer
  // approves or rejects before the run continues) and the AI workforce
  // agent that runs an agent step.
  const type = s.type === undefined ? 'agent' : s.type;
  if (!['agent', 'review'].includes(type)) bad(`steps[${i}].type must be 'agent' or 'review'`);
  let agentId = null;
  if (s.agentId !== undefined && s.agentId !== null) {
    if (typeof s.agentId !== 'string' || !UUID_RE.test(s.agentId)) bad(`steps[${i}].agentId must be an agent id`);
    agentId = s.agentId.toLowerCase();
  }
  if (type === 'review') {
    if (s.connector !== undefined && s.connector !== null) bad(`steps[${i}]: a review step cannot have a connector`);
    if (s.outputs !== undefined && s.outputs !== null) bad(`steps[${i}]: a review step cannot declare outputs`);
    if (agentId) bad(`steps[${i}]: a review step is done by a person, not an agent`);
    const rv = s.review === undefined || s.review === null ? {} : s.review;
    if (!isPlainObject(rv)) bad(`steps[${i}].review must be an object`);
    for (const k of Object.keys(rv)) if (k !== 'reviewerRole') bad(`steps[${i}].review: unknown field "${k}"`);
    const reviewerRole = rv.reviewerRole === undefined ? 'member' : rv.reviewerRole;
    if (!['member', 'admin'].includes(reviewerRole)) bad(`steps[${i}].review.reviewerRole must be member or admin`);
    const rname = str(s.name, `steps[${i}].name`, { min: 1, max: LIMITS.stepName });
    const timeoutM = s.timeoutMinutes === undefined ? 30 : s.timeoutMinutes;
    if (!Number.isInteger(timeoutM) || timeoutM < 1 || timeoutM > 120) bad(`steps[${i}].timeoutMinutes must be 1-120`);
    return {
      key, name: rname, type: 'review',
      instruction: redactString(str(s.instruction, `steps[${i}].instruction`, { min: 1, max: LIMITS.instruction }), LIMITS.instruction),
      expectedOutput: redactString(str(s.expectedOutput, `steps[${i}].expectedOutput`, { max: LIMITS.expectedOutput }), LIMITS.expectedOutput),
      review: { reviewerRole },
      approval: 'auto', verification: 'best_effort', retry: { maxAttempts: 0 }, timeoutMinutes: timeoutM,
    };
  }
  const connector = normalizeConnector(s.connector, i);
  const outputs = normalizeOutputs(s.outputs, i, !!connector);
  const name = str(s.name, `steps[${i}].name`, { min: 1, max: LIMITS.stepName });
  return {
    ...(agentId ? { agentId } : {}),
    key,
    name,
    // Author-written text is redacted too (a secret typed into a template
    // must never be persisted or sent anywhere). A connector step's
    // instruction is optional (it is only a human label).
    instruction: redactString(connector && (s.instruction === undefined || s.instruction === null || s.instruction === '')
      ? name
      : str(s.instruction, `steps[${i}].instruction`, { min: 1, max: LIMITS.instruction }), LIMITS.instruction),
    ...(connector ? { connector } : {}),
    ...(outputs ? { outputs } : {}),
    expectedOutput: redactString(str(s.expectedOutput, `steps[${i}].expectedOutput`, { max: LIMITS.expectedOutput }), LIMITS.expectedOutput),
    approval,
    verification,
    retry: { maxAttempts },
    timeoutMinutes,
  };
}

/**
 * Validates and normalizes a definition. `forPublish` additionally
 * requires at least one step. Template references are always checked:
 * inputs must be declared, step outputs must come from an EARLIER step.
 */
function normalizeDefinition(def, { forPublish = false } = {}) {
  if (def === undefined || def === null) def = {};
  if (!isPlainObject(def)) bad('definition must be an object');
  const variables = def.variables === undefined ? [] : def.variables;
  const steps = def.steps === undefined ? [] : def.steps;
  if (!Array.isArray(variables) || variables.length > LIMITS.variables) bad(`variables must be an array of at most ${LIMITS.variables}`);
  if (!Array.isArray(steps) || steps.length > LIMITS.steps) bad(`steps must be an array of at most ${LIMITS.steps}`);
  if (forPublish && steps.length === 0) bad('A workflow needs at least one step before it can be published');

  const vars = variables.map(normalizeVariable);
  const varNames = new Set();
  for (const v of vars) {
    if (varNames.has(v.name)) bad(`duplicate variable "${v.name}"`);
    varNames.add(v.name);
  }
  const normSteps = steps.map(normalizeStep);
  const seen = new Set();
  const declared = new Map(normSteps.map((s) => [s.key, new Set((s.outputs || []).map((o) => o.name))]));
  normSteps.forEach((s, i) => {
    if (seen.has(s.key)) bad(`duplicate step key "${s.key}"`);
    const texts = [['instruction', s.instruction], ['expectedOutput', s.expectedOutput]];
    if (s.connector) {
      for (const [k, v] of Object.entries(s.connector.input)) {
        if (typeof v === 'string') texts.push([`connector.input.${k}`, v]);
        else if (isPlainObject(v)) for (const [kk, vv] of Object.entries(v)) if (typeof vv === 'string') texts.push([`connector.input.${k}.${kk}`, vv]);
      }
    }
    for (const [field, text] of texts) {
      for (const ref of parseTemplate(text, `steps[${i}].${field}`)) {
        if (ref.kind === 'input' && !varNames.has(ref.name)) bad(`steps[${i}].${field} references undeclared variable "${ref.name}"`);
        if (ref.kind === 'step' && !seen.has(ref.key)) bad(`steps[${i}].${field} may only reference outputs of earlier steps ("${ref.key}")`);
        if (ref.kind === 'step' && ref.output && !declared.get(ref.key).has(ref.output)) bad(`steps[${i}].${field} references undeclared output "${ref.key}.outputs.${ref.output}"`);
      }
    }
    seen.add(s.key);
  });

  const policyIn = isPlainObject(def.policy) ? def.policy : {};
  const maxRunMinutes = policyIn.maxRunMinutes === undefined ? 120 : policyIn.maxRunMinutes;
  if (!Number.isInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 1440) bad('policy.maxRunMinutes must be 1-1440');

  return { variables: vars, steps: normSteps, policy: { maxRunMinutes } };
}

function coerceValue(variable, raw, field) {
  switch (variable.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(n)) bad(`${field} must be a number`);
      return n;
    }
    case 'boolean':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      return bad(`${field} must be true or false`);
    case 'date':
      if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) bad(`${field} must be a date (YYYY-MM-DD)`);
      return raw;
    case 'enum':
      if (typeof raw !== 'string' || !variable.options.includes(raw)) bad(`${field} must be one of ${variable.options.join(', ')}`);
      return raw;
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number') bad(`${field} must be a string`);
      const s = String(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (s.length > (variable.maxLength || 500)) bad(`${field} must be at most ${variable.maxLength || 500} characters`);
      return s;
    }
  }
}

/**
 * Validates run inputs against a version's variables. Returns the
 * REDACTED inputs object — the only form that is ever stored or rendered.
 */
function validateInputs(definition, inputs) {
  if (inputs === undefined || inputs === null) inputs = {};
  if (!isPlainObject(inputs)) bad('inputs must be an object');
  const declared = new Map(definition.variables.map((v) => [v.name, v]));
  for (const k of Object.keys(inputs)) {
    if (!declared.has(k)) bad(`unknown input "${k}"`);
  }
  const out = {};
  const missing = [];
  for (const v of definition.variables) {
    let raw = inputs[v.name];
    if (raw === undefined || raw === null || raw === '') raw = v.default;
    if (raw === undefined || raw === null || raw === '') {
      if (v.required) missing.push(v.name);
      continue;
    }
    const value = coerceValue(v, raw, `inputs.${v.name}`);
    out[v.name] = typeof value === 'string' ? redactString(value, LIMITS.value) : value;
  }
  if (missing.length) throw new DefinitionError(`Missing required input(s): ${missing.join(', ')}`, { missing });
  return out;
}

/**
 * Single-pass substitution. `inputs` must already be redacted
 * (validateInputs) and `stepOutputs` are redacted execution results.
 * Unknown references render as an explicit marker rather than failing
 * the run (definitions are validated on publish, so this only happens
 * when an optional input was not supplied).
 */
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function lookupRef(ctx, input, step, output) {
  const { inputs = {}, stepOutputs = {}, structured = {} } = ctx;
  if (input) return own(inputs, input) ? inputs[input] : undefined;
  if (output) return own(structured, step) && own(structured[step], output) ? structured[step][output] : undefined;
  return own(stepOutputs, step) ? stepOutputs[step] : undefined;
}

function valueToText(v) {
  if (v !== null && typeof v === 'object') {
    const j = JSON.stringify(v);
    return j.length > LIMITS.renderedOutputValue ? `${j.slice(0, LIMITS.renderedOutputValue)}…` : j;
  }
  return String(v);
}

function render(template, ctx = {}) {
  const out = String(template).replace(PLACEHOLDER_RE, (m, _whole, input, step, output) => {
    const v = lookupRef(ctx, input, step, output);
    if (v === undefined || v === null) return input ? '(not provided)' : '(no output)';
    return valueToText(v);
  });
  return redactString(out, LIMITS.renderedGoal);
}

/**
 * Layer 6: connector inputs keep a structured output's type when the
 * template is exactly ONE placeholder of a number/boolean output
 * (e.g. issue_number: "{{steps.find.outputs.number}}" → 42).
 * Everything else renders as text (single pass, never re-scanned).
 */
function renderValue(template, ctx = {}) {
  const t = String(template).trim();
  PLACEHOLDER_RE.lastIndex = 0;
  const m = new RegExp(`^${PLACEHOLDER_RE.source}$`).exec(t);
  if (m && m[4]) {
    const v = lookupRef(ctx, m[2], m[3], m[4]);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
  }
  return render(template, ctx);
}

/**
 * Layer 6: validates a step's structured outputs before ANY later step
 * can use them. Source values come from redacted evidence. Rejects:
 * missing required outputs, wrong types, non-finite numbers, prototype
 * keys, oversize values. Secret-like strings are redacted (sanitize).
 * Returns { ok, values?, error?, redacted, suspicious }.
 */
function validateStructuredOutputs(outputs, source, { sanitize, findSecrets, detectInjection } = {}) {
  if (!outputs || !outputs.length) return { ok: true, values: null, redacted: false, suspicious: false };
  if (!isPlainObject(source)) return { ok: false, error: 'The step produced no structured result to read outputs from.' };
  const values = {};
  const badKeys = (v, d = 0) => {
    if (d > 8) return true;
    if (Array.isArray(v)) return v.some((x) => badKeys(x, d + 1));
    if (v && typeof v === 'object') return Object.keys(v).some((k) => FORBIDDEN_KEYS.has(k) || badKeys(v[k], d + 1));
    return false;
  };
  for (const o of outputs) {
    const v = own(source, o.name) ? source[o.name] : undefined;
    if (v === undefined || v === null) {
      if (o.required) return { ok: false, error: `Required output "${o.name}" is missing.` };
      continue;
    }
    const typeOk = (o.type === 'string' && typeof v === 'string')
      || (o.type === 'number' && typeof v === 'number' && Number.isFinite(v))
      || (o.type === 'boolean' && typeof v === 'boolean')
      || (o.type === 'object' && isPlainObject(v))
      || (o.type === 'array' && Array.isArray(v))
      || (o.type === 'table' && isTable(v))
      || (o.type === 'artifact' && isArtifactRef(v));
    if (!typeOk) return { ok: false, error: `Output "${o.name}" must be of type ${o.type}.` };
    if (badKeys(v)) return { ok: false, error: `Output "${o.name}" contains a forbidden key.` };
    values[o.name] = v;
  }
  let redacted = false;
  let clean = values;
  if (findSecrets && findSecrets(values).length) {
    clean = sanitize(values, { maxString: LIMITS.renderedOutputValue });
    redacted = true;
  }
  if (JSON.stringify(clean).length > LIMITS.structuredOutputBytes) return { ok: false, error: `Structured outputs exceed ${LIMITS.structuredOutputBytes} bytes.` };
  const suspicious = detectInjection ? detectInjection(clean).suspicious : false;
  return { ok: true, values: clean, redacted, suspicious };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashDefinition(def) {
  return crypto.createHash('sha256').update(stableStringify(def), 'utf8').digest('hex');
}

module.exports = {
  normalizeDefinition, validateInputs, render, renderValue, parseTemplate, hashDefinition, stableStringify, validateStructuredOutputs, isTable, isArtifactRef,
  DefinitionError, LIMITS, APPROVALS, VERIFICATIONS, VAR_TYPES, OUTPUT_TYPES,
};
