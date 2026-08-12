// scripts/seed.js — load the demo community into a fresh database.
//
//   npm run seed
//
// Wipes posts/decisions/users/reports, then queues a realistic two-day
// moderation workload for the "Pinewood Forest" demo community: spam,
// harassment, NSFW, off-topic and healthy posts — including a repeat
// offender (bob) who violates on both days so the escalation review has
// something to do.

import config from "../src/config.js";
import { openDb, addPost, counts, wipe } from "../src/db.js";

const db = openDb(config.dbPath);
wipe(db);

const DAY = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const posts = [
  // ── Day 1 (≈26h ago) ──
  { id: "post_day1_alice_wip",   userId: "u_alice", userName: "Alice",   channel: "critique", text: "wip! trying painterly lighting on this forest scene 🎨", postedAt: ago(26 * 3600 * 1000) },
  { id: "post_day1_bob_nft",     userId: "u_bob",   userName: "Bob",     channel: "general",  text: "check out my new NFT collection, dm me for the link", postedAt: ago(25.5 * 3600 * 1000) },
  { id: "post_day1_carl_insult", userId: "u_carl",  userName: "Carl",    channel: "critique", text: "your art is literally trash, uninstall", postedAt: ago(25 * 3600 * 1000) },
  { id: "post_day1_dana_airdrop",userId: "u_dana",  userName: "Dana",    channel: "general",  text: "FREE CRYPTO AIRDROP!!! CLAIM YOUR 100x NOW!!!", postedAt: ago(24 * 3600 * 1000) },
  { id: "post_day1_erin_love",   userId: "u_erin",  userName: "Erin",    channel: "critique", text: "love the colors in your piece, the palette is so warm", postedAt: ago(23 * 3600 * 1000) },
  { id: "post_day1_frank_snark", userId: "u_frank", userName: "Frank",   channel: "critique", text: "lol this looks like my 5yo drew it", postedAt: ago(22 * 3600 * 1000) },
  { id: "post_day1_grace_link",  userId: "u_grace", userName: "Grace",   channel: "general",  text: "https://totally-not-scam.example/win-free-coins", postedAt: ago(21 * 3600 * 1000) },
  { id: "post_day1_henry_caps",  userId: "u_henry", userName: "Henry",   channel: "general",  text: "BUY NOW!!! LIMITED OFFER!!! 100x YOUR ART CAREER", postedAt: ago(20 * 3600 * 1000) },
  // ── Day 2 (≈2h ago) ──
  { id: "post_day2_bob_giveaway",userId: "u_bob",   userName: "Bob",     channel: "general",  text: "guys i'm giving away free crypto to the first 10 dms", postedAt: ago(2 * 3600 * 1000) },
  { id: "post_day2_ivy_wip",     userId: "u_ivy",   userName: "Ivy",     channel: "critique", text: "wip! working on anatomy, critique welcome", postedAt: ago(1.8 * 3600 * 1000) },
  { id: "post_day2_jack_rant",   userId: "u_jack",  userName: "Jack",    channel: "lounge",   text: "mods are stupid, this server is trash", postedAt: ago(1.5 * 3600 * 1000) },
  { id: "post_day2_karen_of",    userId: "u_karen", userName: "Karen",   channel: "general",  text: "check my onlyfans for exclusive art 😉", postedAt: ago(1.2 * 3600 * 1000) },
  { id: "post_day2_leo_3d",      userId: "u_leo",   userName: "Leo",     channel: "lounge",   text: "anyone else playing with 3d sculpting lately?", postedAt: ago(1 * 3600 * 1000) },
  { id: "post_day2_alice_done",  userId: "u_alice", userName: "Alice",   channel: "critique", text: "posted the final version, feedback thread in #critique", postedAt: ago(0.5 * 3600 * 1000) },
];

for (const p of posts) addPost(db, p);

const c = counts(db);
console.log(`Seeded ${c.total} posts for "${config.communityName}":`);
console.log(`  pending: ${c.pending}`);
console.log(`  day-1 spammer: u_bob (repeat offender across both days)`);
console.log(`\nNext: npm start (engine), then npm run discord (bot) — or open the dashboard and click "Review queue →"`);
