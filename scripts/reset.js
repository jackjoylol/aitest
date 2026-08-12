// scripts/reset.js — wipe ALL moderation data (posts, decisions, users,
// reports). Use this for a clean slate: every digest / stat then
// reflects only REAL activity (Discord testing, webhook traffic).
//
//   npm run reset
//
// The blacklist/whitelist dictionaries are files and are NOT touched.
// Norms are NOT re-taught (meta is kept).

import config from "../src/config.js";
import { openDb, wipe, counts } from "../src/db.js";

const db = openDb(config.dbPath);
wipe(db);
const c = counts(db);
console.log(`Wiped all moderation data.`);
console.log(`  pending: ${c.pending} | decisions: ${c.decisions} | users: 0`);
console.log(`\nFrom now on, every digest/stats entry comes from REAL activity only.`);
