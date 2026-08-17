// server.js — Hearthkeeper dashboard server.
//
// Thin product shell around a Minds agent. The Mind is the moderator:
// it learns the community norms (Soul), rules on every post, remembers
// users across sessions, learns from creator overrides, and produces
// the daily digest. This server provides the queue, the audit log, the
// webhook intake, the scheduler and the dashboard.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import config, { ROOT } from "./config.js";
import {
  openDb, addPost, getPost, pendingPosts,
  applyDecision, listDecisions, decisionsInWindow, listUsers, setUserStatus,
  addReport, listReports, getMeta, setMeta, counts,
} from "./db.js";
import { getMinds, resolveMind, MindError } from "./minds.js";
import * as mod from "./moderation.js";
import { startScheduler } from "./scheduler.js";
import {
  loadBlacklist, loadWhitelist, matchBlacklist, matchWhitelist,
  addBlacklistTerm, addWhitelistTerm, loadBannedUsers, isUserBanned,
} from "./blacklist.js";
import { loadAllowedDomains, hasDiscordInvite, findExternalLink } from "./linkguard.js";

// ── Bootstrap ───────────────────────────────────────────────────────

const db = openDb(config.dbPath);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "ui")));

const state = {
  mode: config.mock ? "mock" : "real",
  mind: null,          // { mindId, name, model }
  mindError: null,
  onboarded: false,
  busy: { review: false, digest: false, escalation: false },
};

const normsText = fs.existsSync(config.normsPath)
  ? fs.readFileSync(config.normsPath, "utf8").trim()
  : "Be kind. No spam. Stay on topic.";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ── Minds helpers ───────────────────────────────────────────────────

// Serialise every Mind turn (send + wait) so concurrent flows
// (review / digest / escalation / chat / onboarding) can never steal
// each other's replies on the shared conversation alias.
let mindQueue = Promise.resolve();
function serialized(fn) {
  const run = mindQueue.then(fn, fn);
  mindQueue = run.then(() => {}, () => {});
  return run;
}

async function waitReply(sentText) {
  const minds = await getMinds();
  const before = await minds.getLatestHistoryFingerprint(config.alias);
  const outcome = await minds.waitForReply({
    alias: config.alias,
    timeoutMs: config.replyTimeoutMs,
    afterFingerprint: before,
    sentMessageText: sentText,
  });
  if (outcome.timedOut || !outcome.reply) {
    throw new MindError(`Mind did not reply within ${config.replyTimeoutMs}ms`);
  }
  return outcome.reply.messageText ?? "";
}

/** Teach the norms once; re-teach only when norms/community.md changes. */
async function ensureOnboarded({ force = false } = {}) {
  const hash = crypto.createHash("sha256").update(normsText).digest("hex");
  if (!force && getMeta(db, "norms_sha") === hash) {
    state.onboarded = true;
    return true;
  }
  log("[onboard] teaching community norms to the Mind…");
  const minds = await getMinds();
  // Bind the stable alias first (required before messaging in real mode).
  await minds.ensureConversation(config.alias, state.mind?.mindId ?? config.mindId);
  const prompt = mod.buildOnboardingPrompt({ communityName: config.communityName, normsText });
  await serialized(async () => {
    await minds.sendMessage({ alias: config.alias, messageText: prompt });
    await waitReply(prompt);
  });
  setMeta(db, "norms_sha", hash);
  state.onboarded = true;
  log("[onboard] norms taught (Soul memory updated)");
  return true;
}

function friendlyError(err) {
  if (err instanceof MindError) return { message: err.message, code: err.code };
  return { message: err?.message ?? String(err) };
}

/** Is this member a "newbie" (joined less than cooldownHours ago)? */
function isNewMember(userId, cooldownHours) {
  const user = db.prepare("SELECT first_seen FROM users WHERE id = ?").get(userId);
  if (!user) return true; // unknown member → treat as new
  const ageMs = Date.now() - new Date(user.first_seen).getTime();
  return ageMs < cooldownHours * 3600 * 1000;
}

async function refreshMindInfo() {
  try {
    const minds = await getMinds();
    const mind = await resolveMind(minds);
    state.mind = { mindId: mind.mindId, name: mind.name, model: mind.model };
    state.mindError = null;
  } catch (err) {
    state.mind = null;
    state.mindError = friendlyError(err);
  }
}

// ── Core actions (shared by API routes and the scheduler) ───────────

async function runReview() {
  if (state.busy.review) return { skipped: true, reason: "review already in progress" };
  state.busy.review = true;
  try {
    // Check the queue BEFORE onboarding: an empty queue shouldn't spend
    // a cognition turn re-teaching norms.
    const batch = pendingPosts(db, config.batchSize);
    if (batch.length === 0) return { reviewed: 0, message: "Queue is empty" };

    await ensureOnboarded();
    const id = mod.batchId();
    log(`[review] batch=${id} — ${batch.length} posts → Mind`);
    const prompt = mod.buildReviewPrompt({
      batchId: id,
      communityName: config.communityName,
      posts: batch,
      normsText,
    });
    const minds = await getMinds();
    let reply;
    await serialized(async () => {
      await minds.sendMessage({ alias: config.alias, messageText: prompt });
      reply = await waitReply(prompt);
    });
    log(`[review] batch=${id} — Mind replied (${reply.length} chars)`);

    const parsed = mod.parseReviewReply(reply);
    if (parsed.error) {
      log(`[review] batch=${id} — unparseable reply: ${parsed.error}`);
      for (const p of batch) {
        applyDecision(db, {
          postId: p.id, action: "flag", severity: "medium", category: "other",
          reason: `Mind reply unparseable — human review: ${parsed.error}`, source: "system",
        });
      }
      return { reviewed: batch.length, error: parsed.error, rawReply: reply.slice(0, 2000) };
    }

    const byIndex = new Map(batch.map((p, i) => [String(i + 1), p.id]));
    const applied = [];
    for (const v of parsed.verdicts) {
      const postId = byIndex.get(v.postId);
      if (!postId) continue; // verdict references an unknown index — ignore
      const post = batch.find((p) => p.id === postId);
      applyDecision(db, { postId, action: v.action, severity: v.severity, category: v.category, reason: v.reason, source: "mind" });
      applied.push({ ...v, postId, user_name: post?.user_name ?? "" });

      // Learning loop: the Mind named the keywords behind its ruling —
      // file them into the blacklist (remove) or whitelist (allow) so
      // future identical content is handled instantly, no Mind call.
      // Guardrail: a keyword is only learned if it ACTUALLY appears in
      // the post text — this stops the Mind from filing user IDs,
      // reason phrases or other hallucinated terms into the dictionary.
      // Never let a file-write error abort the review itself.
      try {
        const postText = (post?.text ?? "").toLowerCase();
        for (const kw of v.keywords ?? []) {
          if (!postText.includes(kw.toLowerCase())) {
            log(`[learn] skipped "${kw}" (${postId}) — not in post text`);
            continue;
          }
          if (v.action === "remove") {
            const r = addBlacklistTerm(kw);
            if (r.ok) log(`[learn] blacklist += "${kw}" (${postId})`);
          } else if (v.action === "allow") {
            const r = addWhitelistTerm(kw);
            if (r.ok) log(`[learn] whitelist += "${kw}" (${postId})`);
          }
        }
      } catch (err) {
        log(`[learn] keyword filing failed for ${postId}: ${err.message}`);
      }
    }
    // Posts the Mind did not rule on → human review.
    const decided = new Set(applied.map((a) => a.postId));
    for (const p of batch) {
      if (!decided.has(p.id)) {
        applyDecision(db, {
          postId: p.id, action: "flag", severity: "medium", category: "other",
          reason: "No verdict returned by the Mind — human review", source: "system",
        });
        applied.push({ postId: p.id, action: "flag", severity: "medium", category: "other", reason: "No verdict returned by the Mind", user_name: p.user_name });
      }
    }
    log(`[review] batch=${id} — ${applied.length} verdicts applied`);
    return { reviewed: applied.length, verdicts: applied, batchId: parsed.batchId || id };
  } finally {
    state.busy.review = false;
  }
}

async function runDigest() {
  if (state.busy.digest) return { skipped: true };
  state.busy.digest = true;
  try {
    await ensureOnboarded();
    const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const decisions = decisionsInWindow(db, { sinceIso });
    const c = mod.digestCounts(decisions);
    c.pending = counts(db).pending;
    const offenders = listUsers(db, { withViolationsOnly: true })
      .filter((u) => u.violations > 0)
      .map((u) => ({ user_id: u.id, violations: u.violations }));

    const prompt = mod.buildDigestPrompt({
      communityName: config.communityName,
      windowLabel: "last 24 hours",
      counts: c,
      repeatOffenders: offenders,
    });
    log("[digest] asking the Mind for the community health report…");
    const minds = await getMinds();
    let reply;
    await serialized(async () => {
      await minds.sendMessage({ alias: config.alias, messageText: prompt });
      reply = await waitReply(prompt);
    });
    const parsed = mod.parseDigestReply(reply);
    if (parsed.error) {
      const report = addReport(db, { kind: "digest", title: "Digest failed", body: JSON.stringify({ error: parsed.error, raw: reply.slice(0, 500) }) });
      return { report, error: parsed.error };
    }
    const report = addReport(db, {
      kind: "digest",
      title: `Community health: ${parsed.healthScore ?? "?"}/100`,
      body: JSON.stringify(parsed),
    });
    log(`[digest] health=${parsed.healthScore} — "${parsed.summary.slice(0, 80)}"`);
    return { report, parsed };
  } finally {
    state.busy.digest = false;
  }
}

async function runEscalation() {
  if (state.busy.escalation) return { skipped: true };
  state.busy.escalation = true;
  try {
    await ensureOnboarded();
    const users = listUsers(db, { withViolationsOnly: true })
      .filter((u) => u.violations > 0 && !["banned", "restricted"].includes(u.status));
    if (users.length === 0) return { escalated: 0, message: "No repeat offenders" };

    const members = users.map((u) => {
      const last = db.prepare(`
        SELECT d.category FROM decisions d JOIN posts p ON p.id = d.post_id
        WHERE p.user_id = ? AND d.action != 'allow' ORDER BY d.created_at DESC LIMIT 1
      `).get(u.id);
      return { user_id: u.id, violations: u.violations, last_category: last?.category ?? "unknown" };
    });

    const prompt = mod.buildEscalationPrompt({
      batchId: mod.batchId(),
      communityName: config.communityName,
      members,
      normsText,
    });
    log(`[escalation] asking the Mind to rule on ${members.length} repeat offender(s)…`);
    const minds = await getMinds();
    let reply;
    await serialized(async () => {
      await minds.sendMessage({ alias: config.alias, messageText: prompt });
      reply = await waitReply(prompt);
    });
    const parsed = mod.parseEscalationReply(reply);
    if (parsed.error) {
      addReport(db, { kind: "escalation", title: "Escalation review failed", body: JSON.stringify({ error: parsed.error, raw: reply.slice(0, 500) }) });
      return { escalated: 0, error: parsed.error };
    }
    const applied = [];
    for (const m of parsed.members) {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(m.userId);
      if (!user) continue;
      const status = { warn: "warned", restrict: "restricted", ban: "banned" }[m.action] ?? "warned";
      setUserStatus(db, m.userId, status, m.reason);
      applied.push({ userId: m.userId, action: m.action, reason: m.reason, fromStatus: user.status });
      log(`[escalation] ${m.userId} → ${status} (${m.reason})`);
    }
    if (applied.length) {
      addReport(db, {
        kind: "escalation",
        title: `Escalated ${applied.length} member(s)`,
        body: JSON.stringify(applied),
      });
    }
    return { escalated: applied.length, members: applied };
  } finally {
    state.busy.escalation = false;
  }
}

// ── API routes ──────────────────────────────────────────────────────

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "ui", "index.html")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: state.mode, mind: state.mind?.name ?? null, onboarded: state.onboarded });
});

app.get("/api/state", async (_req, res) => {
  let balance = null;
  if (!config.mock && state.mind) {
    try {
      const minds = await getMinds();
      const b = await minds.getCognitionBalance(state.mind.mindId);
      balance = b.cognition;
    } catch { /* non-fatal */ }
  }
  res.json({
    mode: state.mode,
    communityName: config.communityName,
    mind: state.mind,
    mindError: state.mindError,
    onboarded: state.onboarded,
    busy: state.busy,
    cognitionBalance: balance,
    counts: counts(db),
    queue: pendingPosts(db, 50),
    decisions: listDecisions(db, 100),
    users: listUsers(db),
    reports: listReports(db, 10),
  });
});

function normalizePostInput(body) {
  const rawPosts = Array.isArray(body?.posts) ? body.posts : body ? [body] : [];
  const posts = [];
  for (const r of rawPosts) {
    const userId = String(r.userId ?? r.user_id ?? r.user ?? "").trim();
    const userName = String((r.userName ?? r.user_name ?? r.username) || userId || "anonymous").trim();
    const text = String(r.text ?? r.content ?? r.message ?? "").trim();
    if (!userId || !text) continue;
    const id = String(r.id ?? `post_${crypto.randomBytes(6).toString("hex")}`).trim();
    posts.push({
      id,
      userId: userId.replace(/[^A-Za-z0-9_-]/g, "_"),
      userName,
      channel: String(r.channel ?? "general").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 40),
      text: text.slice(0, 4000),
      postedAt: r.postedAt ?? new Date().toISOString(),
    });
  }
  return posts;
}

// Ingest posts (dashboard form, or any platform via webhook).
app.post(["/api/posts", "/api/webhook"], (req, res) => {
  if (req.path === "/api/webhook" && config.webhookToken) {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${config.webhookToken}`;
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: "Invalid webhook token" });
  }
  const posts = normalizePostInput(req.body);
  if (posts.length === 0) return res.status(400).json({ error: "No valid posts in body" });

  // Deterministic checks, done before the Mind:
  // 1. member blacklisted → instant remove (whatever the content)
  // 2. blacklist term hit → instant remove
  // 3. whitelist term hit → instant allow
  // 4. message flood (same user, short window) → instant remove
  // 5. otherwise → queued for the Mind
  const blackTerms = loadBlacklist();
  const whiteTerms = loadWhitelist();
  const banned = loadBannedUsers();
  const allowedDomains = loadAllowedDomains();
  const newbieCooldownHours = Number(getMeta(db, "newbie_cooldown_hours", config.newbieCooldownHours));
  const holdNewbie = config.holdNewbieForReview;
  const created = [];
  const blacklisted = [];
  const whitelisted = [];
  const flooded = [];
  const memberBanned = [];
  const externalLinks = [];
  const discordInvites = [];
  const newbieHeld = [];
  const floodSince = new Date(Date.now() - config.floodWindowMs).toISOString();
  for (const p of posts) {
    if (isUserBanned(p.userId, banned)) {
      addPost(db, p);
      const post = applyDecision(db, {
        postId: p.id, action: "remove", severity: "high", category: "other",
        reason: "Member is blacklisted (拉黑用户)", source: "system",
      });
      memberBanned.push({ ...post, matchedTerm: "banned-member" });
      log(`[ingest] ${p.id} auto-removed (member blacklisted: ${p.userId})`);
      continue;
    }

    // Link guard — Discord invites are always a violation.
    if (hasDiscordInvite(p.text)) {
      addPost(db, p);
      const post = applyDecision(db, {
        postId: p.id, action: "remove", severity: "high", category: "off-topic",
        reason: "Discord invite link posted (邀請鏈接攔截)", source: "system",
      });
      discordInvites.push({ ...post, matchedTerm: "discord-invite" });
      log(`[ingest] ${p.id} auto-removed (discord invite)`);
      continue;
    }

    // External promotional link — allowed only if host is allow-listed.
    const extHost = findExternalLink(p.text, allowedDomains);
    if (extHost) {
      const isNewbie = isNewMember(p.userId, newbieCooldownHours);
      addPost(db, p);
      if (isNewbie && holdNewbie) {
        // New member: don't auto-delete their whole account; hold the
        // message for human review.
        const post = applyDecision(db, {
          postId: p.id, action: "flag", severity: "medium", category: "spam",
          reason: `New member posted external link (${extHost}) within ${newbieCooldownHours}h cooldown — held for review`, source: "system",
        });
        newbieHeld.push({ ...post, matchedTerm: extHost });
        log(`[ingest] ${p.id} newbie external link held: ${extHost}`);
      } else {
        const post = applyDecision(db, {
          postId: p.id, action: "remove", severity: "high", category: "spam",
          reason: `External promotional link blocked (${extHost}) — not allow-listed / newbie cooldown`, source: "system",
        });
        externalLinks.push({ ...post, matchedTerm: extHost });
        log(`[ingest] ${p.id} external link removed: ${extHost}`);
      }
      continue;
    }

    const bad = matchBlacklist(p.text, blackTerms);
    if (bad) {
      addPost(db, p);
      const post = applyDecision(db, {
        postId: p.id, action: "remove", severity: "high", category: "blacklist",
        reason: `Blacklisted term: "${bad}"`, source: "system",
      });
      blacklisted.push({ ...post, matchedTerm: bad });
      log(`[ingest] ${p.id} auto-removed (blacklist: "${bad}")`);
      continue;
    }
    const good = matchWhitelist(p.text, whiteTerms);
    if (good) {
      addPost(db, p);
      const post = applyDecision(db, {
        postId: p.id, action: "allow", severity: "none", category: "none",
        reason: `Whitelisted term: "${good}"`, source: "system",
      });
      whitelisted.push({ ...post, matchedTerm: good });
      log(`[ingest] ${p.id} auto-allowed (whitelist: "${good}")`);
      continue;
    }
    // Flood guard: same member flooding the queue inside the window.
    const recent = db.prepare(
      "SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND posted_at >= ?"
    ).get(p.userId, floodSince);
    if (recent.c >= config.floodMax) {
      addPost(db, p);
      const post = applyDecision(db, {
        postId: p.id, action: "remove", severity: "medium", category: "spam",
        reason: `Message flood: ${recent.c + 1} posts from this member within ${Math.round(config.floodWindowMs / 1000)}s`, source: "system",
      });
      flooded.push({ ...post, matchedTerm: "flood" });
      log(`[ingest] ${p.id} auto-removed (flood: ${recent.c + 1} in window)`);
      continue;
    }
    created.push(addPost(db, p));
  }
  log(`[ingest] ${created.length} queued, ${blacklisted.length} blacklisted, ${whitelisted.length} whitelisted, ${flooded.length} flooded, ${memberBanned.length} member-banned, ${externalLinks.length} ext-links, ${discordInvites.length} invites, ${newbieHeld.length} newbie-held`);
  res.status(201).json({ created: created.length, posts: created, blacklisted, whitelisted, flooded, memberBanned, externalLinks, discordInvites, newbieHeld });
});

// Review the queue with the Mind (also called by the scheduler).
app.post("/api/review", async (_req, res) => {
  try {
    const result = await runReview();
    res.json(result); // {skipped:true} is a normal outcome (double-trigger guard)
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

// Creator overrides a verdict → audit + correction loop to the Mind.
app.post("/api/decisions/:postId/override", async (req, res) => {
  const { postId } = req.params;
  const to = String(req.body?.to ?? "");
  const note = String(req.body?.note ?? "").slice(0, 500);
  if (!mod.ACTIONS.includes(to)) return res.status(400).json({ error: `"to" must be one of ${mod.ACTIONS.join(", ")}` });
  const post = getPost(db, postId);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (!post.action) return res.status(409).json({ error: "Post has no verdict to override" });
  const fromAction = post.action;

  applyDecision(db, { postId, action: to, severity: post.severity, category: post.category, reason: note || `Creator override: ${fromAction} → ${to}`, source: "creator-override" });
  log(`[override] ${postId}: ${fromAction} → ${to} by creator`);

  // Fire-and-forget: teach the Mind the correction (Soul memory).
  getMinds()
    .then((minds) => minds.sendMessage({
      alias: config.alias,
      messageText: mod.buildOverrideMessage({ post, fromAction, toAction: to, note }),
    }))
    .then(() => log(`[override] correction sent to the Mind for ${postId}`))
    .catch((err) => log(`[override] correction failed: ${err.message}`));

  res.json({ post: getPost(db, postId) });
});

app.post("/api/escalate", async (_req, res) => {
  try {
    res.json(await runEscalation());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.post("/api/digest", async (_req, res) => {
  try {
    res.json(await runDigest());
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.post("/api/onboard", async (req, res) => {
  try {
    await ensureOnboarded({ force: req.body?.force === true });
    res.json({ onboarded: true });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

// Read/update dynamic settings (used by Discord !onboard cooldown).
app.get("/api/settings", (_req, res) => {
  res.json({
    newbieCooldownHours: Number(getMeta(db, "newbie_cooldown_hours", config.newbieCooldownHours)),
    holdNewbieForReview: config.holdNewbieForReview,
    allowedDomains: loadAllowedDomains(),
  });
});

app.post("/api/settings", (req, res) => {
  const { newbieCooldownHours, holdNewbieForReview } = req.body ?? {};
  if (newbieCooldownHours !== undefined) {
    const v = Number(newbieCooldownHours);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "newbieCooldownHours must be a non-negative number" });
    setMeta(db, "newbie_cooldown_hours", String(v));
  }
  if (holdNewbieForReview !== undefined) {
    config.holdNewbieForReview = !!holdNewbieForReview;
  }
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const minds = await getMinds();
    let reply;
    await serialized(async () => {
      await minds.sendMessage({ alias: config.alias, messageText: text.slice(0, 2000) });
      reply = await waitReply(text.slice(0, 2000));
    });
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const minds = await getMinds();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const after = req.query.after ? String(req.query.after) : null;
    const rows = await minds.getHistory(config.alias, { after, limit });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

// ── Scheduler (autonomous follow-up) ────────────────────────────────

startScheduler({
  log,
  onAutoReview: {
    pendingCount: () => counts(db).pending,
    run: () => runReview(),
  },
  onDigest: { run: () => runDigest() },
  onEscalation: { run: () => runEscalation() },
});

// ── Start ───────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  log(`Hearthkeeper ${state.mode === "mock" ? "(MOCK MODE)" : ""} → http://localhost:${config.port}`);
  log(`community: ${config.communityName} | alias: ${config.alias} | db: ${config.dbPath}`);
  if (!config.mock && !config.webhookToken) {
    log("⚠ WEBHOOK_TOKEN is not set — POST /api/webhook is unauthenticated. Set it if the server is reachable from outside.");
  }
});

// Background init: resolve the Mind, bind the alias, teach norms —
// never blocks startup.
(async () => {
  await refreshMindInfo();
  if (state.mind) {
    log(`Mind: ${state.mind.name} (${state.mind.mindId})`);
    try {
      const minds = await getMinds();
      await minds.ensureConversation(config.alias, state.mind.mindId);
      log(`[init] conversation alias "${config.alias}" bound`);
      await ensureOnboarded();
    } catch (err) {
      log(`[init] failed (will retry before first review): ${err.message}`);
    }
  }
})();

function shutdown() {
  log("shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
