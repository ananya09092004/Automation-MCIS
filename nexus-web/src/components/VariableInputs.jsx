import { humanize } from '../lib/format.js';

/** Typed inputs for a workflow / template definition (text, number, date, enum, boolean). */
export function collectInputs(vars, values) {
  const inputs = {};
  for (const v of vars || []) {
    const raw = values[v.name] !== undefined ? values[v.name] : v.default;
    let val;
    if (raw === undefined || raw === '') val = undefined;
    else if (v.type === 'number') val = Number(raw);
    else if (v.type === 'boolean') val = raw === true || raw === 'true';
    else val = raw;
    if (val === undefined) { if (v.required) return { error: `${v.label || humanize(v.name)} is required.` }; continue; }
    if (v.type === 'number' && !Number.isFinite(val)) return { error: `${v.label || humanize(v.name)} must be a number.` };
    inputs[v.name] = val;
  }
  return { inputs };
}

export default function VariableInputs({ vars, values, setValues }) {
  return (vars || []).map((v) => (
    <label key={v.name} className="field">
      <span>{v.label || humanize(v.name)}{v.required ? ' *' : ''}</span>
      {v.type === 'enum' ? (
        <select value={values[v.name] ?? v.default ?? ''} onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}>
          <option value="">Select…</option>
          {(v.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : v.type === 'boolean' ? (
        <select value={String(values[v.name] ?? v.default ?? '')} onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}>
          <option value="">Select…</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      ) : (
        <input type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'} value={values[v.name] ?? v.default ?? ''} maxLength={v.maxLength || 500}
          onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))} />
      )}
    </label>
  ));
}
