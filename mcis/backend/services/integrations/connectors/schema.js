/**
 * Layer 5 — tiny declarative input validation shared by connectors.
 *
 *   fields: { name: { type: 'string'|'integer'|'enum'|'object', required, maxLength,
 *                     pattern, min, max, options, maxKeys } }
 *
 * Unknown fields are rejected. Values that arrive as strings (workflow
 * templates always render to strings) are coerced for integer fields.
 */
'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.status = 400;
    this.code = 'INVALID_CONNECTOR_INPUT';
  }
}

/**
 * Error raised by a connector's execute/healthCheck. `authFailed` marks
 * provider-rejected credentials (the integration is then flagged).
 * Messages are generic and written by us — never provider bodies/headers.
 */
class ConnectorError extends Error {
  constructor(code, message, { authFailed = false, retryable = false } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.authFailed = authFailed;
    this.retryable = retryable;
  }
}

function validateInput(fields, input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new InputError('input must be an object');
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) throw new InputError(`unknown input "${k}"`);
  }
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    let v = input[name];
    if (v === undefined || v === null || v === '') {
      if (f.default !== undefined) v = f.default;
      else if (f.required) throw new InputError(`input "${name}" is required`);
      else continue;
    }
    switch (f.type) {
      case 'integer': {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);
        if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          throw new InputError(`input "${name}" must be an integer${f.min !== undefined ? ` between ${f.min} and ${f.max}` : ''}`);
        }
        out[name] = n;
        break;
      }
      case 'enum':
        if (!f.options.includes(v)) throw new InputError(`input "${name}" must be one of ${f.options.join(', ')}`);
        out[name] = v;
        break;
      case 'object': {
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { throw new InputError(`input "${name}" must be a JSON object`); }
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InputError(`input "${name}" must be an object`);
        const size = Buffer.byteLength(JSON.stringify(v), 'utf8');
        if (size > (f.maxBytes || 16384)) throw new InputError(`input "${name}" is too large`);
        if (f.stringValues) {
          if (Object.keys(v).length > (f.maxKeys || 20)) throw new InputError(`input "${name}" has too many keys`);
          for (const [k, x] of Object.entries(v)) {
            if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') || String(x).length > 500) {
              throw new InputError(`input "${name}" must map simple keys to short values`);
            }
          }
        }
        out[name] = v;
        break;
      }
      default: {
        if (typeof v !== 'string' && typeof v !== 'number') throw new InputError(`input "${name}" must be a string`);
        const s = String(v);
        if (s.length > (f.maxLength || 500)) throw new InputError(`input "${name}" is too long`);
        if (f.pattern && !f.pattern.test(s)) throw new InputError(`input "${name}" has an invalid format`);
        out[name] = s;
      }
    }
  }
  return out;
}

/** Public, serializable description of fields (for the API / UI). */
function describeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, {
    type: f.type || 'string', required: !!f.required, ...(f.options ? { options: f.options } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}), ...(f.min !== undefined ? { min: f.min, max: f.max } : {}),
    ...(f.description ? { description: f.description } : {}),
  }]));
}

module.exports = { validateInput, describeFields, InputError, ConnectorError };
