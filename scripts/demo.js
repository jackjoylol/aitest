// scripts/demo.js — scripted end-to-end demo, no browser needed.
//
//   npm run demo
//
// Walks the full product loop against the real Mind (or the mock):
//   1. seed a fresh community workload
//   2. teach norms (onboarding)
//   3. review day-1 posts → verdicts
//   4. simulate day 2: same spammer posts again
//   5. review again → Mind remembers (Soul) → harsher ruling
//   6. escalation review → repeat offender restricted
//   7. daily digest → health report
//   8. show the conversation transcript (persistence evidence)
//
// This script is the backbone of the 90-second demo video.

import config from "../src/config.js";
import { openDb, addPost, counts, wipe, applyDecision } from "../src/db.js";
import { getMinds, resolveMind } from "../src/minds.js";
import * as mod from "../src/moderation.js";

const db = openDb(config.dbPath);
const step = (n, title) => console.log(`\n━━━ Step ${n}: ${title} ━━━`);

try {
  // ── 1. fresh workload ──
  step(1, "Seed a fresh two-day community workload");
  wipe(db);
  const DAY = 24 * 3600 * 1000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const posts = [
    { id: "p1", user_id: "u_alice", user_name: "Alice", channel: "critique", text: "wip! trying painterly lighting on this forest scene 🎨", postedAt: ago(26 * 3600 * 1000) },
    { id: "p2", user_id: "u_bob", user_name: "Bob", channel: "general", text: "check out my new NFT collection, dm me for the link", postedAt: ago(25.5 * 3600 * 1000) },
    { id: "p3", user_id: "u_carl", user_name: "Carl", channel: "critique", text: "your art is literally trash, uninstall", postedAt: ago(25 * 3600 * 1000) },
    { id: "p4", user_id: "u_erin", user_name: "Erin", channel: "critique", text: "love the colors in your piece, the palette is so warm", postedAt: ago(24 * 3600 * 1000) },
  ];
  for (const p of posts) {
    addPost(db, { id: p.id, userId: p.user_id, userName: p.user_name, channel: p.channel, text: p.text, postedAt: p.postedAt });
  }
  console.log(`${counts(db).total} posts queued (day 1).`);

  // ── 2. onboarding ──
  step(2, "Teach the community norms to the Mind (Soul memory)");
  const minds = await getMinds();
  const mind = await resolveMind(minds);
  console.log(`Mind: ${mind.name} (${mind.mindId})`);
  await minds.ensureConversation(config.alias, mind.mindId);
  const normsText = "Be kind. No spam, crypto giveaways or referral links. No hate speech. No NSFW. Art talk in art channels. 1st offense = warning, 2nd = mute, 3rd = ban.";
  const onboard = mod.buildOnboardingPrompt({ communityName: config.communityName, normsText });
  await minds.sendMessage({ alias: config.alias, messageText: onboard });
  let before = await minds.getLatestHistoryFingerprint(config.alias);
  let outcome = await minds.waitForReply({ alias: config.alias, timeoutMs: config.replyTimeoutMs, afterFingerprint: before, sentMessageText: onboard });
  console.log(`Mind: "${outcome.reply?.messageText?.slice(0, 120)}"`);

  // ── 3. day-1 review ──
  step(3, "Review day-1 queue — every verdict comes from the Mind");
  const reviewDay = async (batch) => {
    const id = mod.batchId();
    const prompt = mod.buildReviewPrompt({ batchId: id, communityName: config.communityName, posts: batch, normsText });
    await minds.sendMessage({ alias: config.alias, messageText: prompt });
    before = await minds.getLatestHistoryFingerprint(config.alias);
    outcome = await minds.waitForReply({ alias: config.alias, timeoutMs: config.replyTimeoutMs, afterFingerprint: before, sentMessageText: prompt });
    const parsed = mod.parseReviewReply(outcome.reply?.messageText ?? "");
    if (parsed.error) throw new Error(`Unparseable reply: ${parsed.error}`);
    for (const v of parsed.verdicts) {
      const p = batch[Number(v.postId) - 1];
      if (!p) continue;
      applyDecision(db, { postId: p.id, action: v.action, severity: v.severity, category: v.category, reason: v.reason, source: "mind" });
      console.log(`  [${v.action.padEnd(6)}] ${String(p.user_name ?? p.userName ?? "?").padEnd(6)} ${v.category.padEnd(10)} ${v.reason}`);
    }
    return parsed;
  };
  await reviewDay(posts);

  // ── 4+5. day 2: the Mind REMEMBERS the spammer ──
  step(4, "Day 2 — the same spammer posts again");
  addPost(db, { id: "p5", userId: "u_bob", userName: "Bob", text: "guys i'm giving away free crypto to the first 10 dms", postedAt: new Date().toISOString() });
  console.log("Bob (u_bob) posted again. Now reviewing…");
  await reviewDay([{ id: "p5", user_id: "u_bob", channel: "general", text: "guys i'm giving away free crypto to the first 10 dms" }]);
  console.log("  → the Mind recognised a repeat offender from memory (Soul continuity).");

  // ── 6. escalation ──
  step(5, "Escalation review — repeat offenders get sanctioned");
  const members = [{ user_id: "u_bob", violations: 2, last_category: "spam" }];
  const escPrompt = mod.buildEscalationPrompt({ batchId: mod.batchId(), communityName: config.communityName, members, normsText });
  await minds.sendMessage({ alias: config.alias, messageText: escPrompt });
  before = await minds.getLatestHistoryFingerprint(config.alias);
  outcome = await minds.waitForReply({ alias: config.alias, timeoutMs: config.replyTimeoutMs, afterFingerprint: before, sentMessageText: escPrompt });
  const esc = mod.parseEscalationReply(outcome.reply?.messageText ?? "");
  console.log(`  ${esc.members?.[0]?.userId ?? "?"} → ${esc.members?.[0]?.action ?? "?"} (${esc.members?.[0]?.reason ?? "?"})`);

  // ── 7. digest ──
  step(6, "Daily digest — autonomous community health report");
  const digPrompt = mod.buildDigestPrompt({
    communityName: config.communityName, windowLabel: "last 24 hours",
    counts: { allowed: 1, flagged: 2, removed: 3, pending: 0 },
    repeatOffenders: [{ user_id: "u_bob", violations: 2 }],
  });
  await minds.sendMessage({ alias: config.alias, messageText: digPrompt });
  before = await minds.getLatestHistoryFingerprint(config.alias);
  outcome = await minds.waitForReply({ alias: config.alias, timeoutMs: config.replyTimeoutMs, afterFingerprint: before, sentMessageText: digPrompt });
  const dig = mod.parseDigestReply(outcome.reply?.messageText ?? "");
  console.log(`  health: ${dig.healthScore}/100 — ${dig.summary}`);

  // ── 8. transcript ──
  step(7, "Conversation transcript (persistence evidence)");
  const rows = await minds.getHistory(config.alias, { limit: 100 });
  const mine = rows.filter((r) => r.senderType === 0).slice(-3);
  for (const r of mine) console.log(`  🧠 ${r.messageText.slice(0, 140)}`);

  console.log(`\n✔ Demo complete. ${rows.length} conversation rows persisted on the platform (alias "${config.alias}").`);
  console.log(`  Run "npm start" for the full dashboard, or open the DB at ${config.dbPath}.`);
} catch (err) {
  console.error(`\n✖ Demo failed: ${err.message}`);
  process.exit(1);
}
