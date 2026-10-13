#!/usr/bin/env node
/**
 * Layer 8 — production configuration check.
 *
 *   node scripts/check-config.js            (reads .env + the environment)
 *   node scripts/check-config.js --json
 *
 * Prints setting NAMES and their status only — never a value. Exit code 1
 * when a required / conditional setting is missing or invalid, or a
 * development-only switch is on. See docs/PRODUCTION_CONFIG.md.
 */
'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { checkConfig } = require('../services/config/productionConfig');

const r = checkConfig(process.env);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const order = ['required', 'conditional', 'development-only', 'optional'];
  for (const g of order) {
    const rows = r.items.filter((i) => i.group === g);
    if (!rows.length) continue;
    console.log(`\n${g.toUpperCase()}`);
    for (const i of rows) console.log(`  [${i.status.padEnd(16)}] ${i.name}${i.note ? ` — ${i.note}` : ''}`);
  }
  console.log(`\n${r.errors.length} error(s), ${r.warnings.length} warning(s)${r.ok ? '' : ' — NOT ready for production'}`);
}
process.exit(r.ok ? 0 : 1);
