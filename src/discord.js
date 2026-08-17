// discord.js — the Discord face of Hearthkeeper.
//
// Listens to your server's channels and runs every message through the
// same Minds-powered moderation pipeline as the dashboard:
//   1. message → POST /api/webhook
//      - blacklisted terms → INSTANT auto-remove (no Mind call)
//      - otherwise → queued for the Mind
//   2. POST /api/review                 (the Mind rules on the batch)
//   3. verdict → posted back to Discord (with auto-delete on "remove")
//
// No dashboard needed: `npm start` runs the engine in the background,
// `npm run discord` runs this bot. All bot messages are in English.
//
// Commands (in the channel):
//   !help                            — command list
//   !review                          — review the whole queue now
//   !audit                           — queue + escalation + digest
//   !flagged                         — posts waiting for human review
//   !decide <postId> <action> [note] — human ruling (taught to the Mind)
//   !digest                          — today's health report
//   !blacklist list|add|remove <t>   — manage the blacklist dictionary
//   !stats                           — member violation stats
//
// Setup: see docs/DISCORD.md.

import config from "./config.js";
import {
  loadBlacklist, loadWhitelist, addBlacklistTerm, removeBlacklistTerm,
  addWhitelistTerm, removeWhitelistTerm, loadBannedUsers,
  addBannedUser, removeBannedUser,
} from "./blacklist.js";

if (!config.discordToken) {
  console.error("✖ DISCORD_TOKEN is not set. See docs/DISCORD.md for setup.");
  process.exit(1);
}

const { Client, GatewayIntentBits, Events } = await import("discord.js");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // For the new-member welcome: requires "SERVER MEMBERS INTENT"
    // enabled in the Developer Portal (see docs/DISCORD.md).
    GatewayIntentBits.GuildMembers,
  ],
});

const API = `http://localhost:${config.port}`;
const EMOJI = { allow: "🟢", flag: "🟡", remove: "🔴" };
const MAX_LEN = 1900; // Discord message limit (2000) minus headroom
const MUTE_MS = 10 * 60 * 1000; // 2nd violation → 10-minute timeout
const BAN_THRESHOLD = 3; // 3rd violation → ban warning (enforcement stays manual via !enforce)

// When DISCORD_OUTPUT_CHANNEL_ID is set, ALL bot/Mind output is sent
// there instead of the channel the message came from.
let outChannel = null;

// One review loop at a time: messages queue up while the Mind works,
// then get ruled in batches — nothing is silently skipped.
let reviewLoopRunning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (config.webhookToken) headers.Authorization = `Bearer ${config.webhookToken}`;
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Review rounds can legitimately take up to MIND_REPLY_TIMEOUT_MS
    // (180s); give requests a little headroom and never hang forever.
    signal: AbortSignal.timeout(200_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Queue review loop. Called after every ingested message; only one loop
 * runs at a time. It keeps calling /api/review — waiting out any
 * in-flight round — until the whole queue is drained, then posts every
 * verdict and performs Discord-side actions (delete + private warning).
 */
async function ensureReviewLoop(channel, dest) {
  if (reviewLoopRunning) return;
  reviewLoopRunning = true;
  try {
    for (let round = 0; round < 8; round++) {
      let r;
      try {
        r = await api("/api/review", {});
      } catch (err) {
        log(`[loop] review call failed: ${err.message}`);
        await sleep(15_000);
        continue;
      }
      if (r.body.skipped) {
        // The Mind is still ruling on the previous batch — wait, don't drop.
        await sleep(15_000);
        continue;
      }
      if (r.body.error) {
        log(`[loop] review error: ${r.body.error}`);
        await dest.send(`⚠️ Review round failed (moved to human review): ${r.body.error}`).catch(() => {});
        break;
      }
      const verdicts = r.body.verdicts ?? [];
      if (verdicts.length === 0) break; // queue drained

      const rows = verdicts.map((v) => ({
        ...v,
        label: v.user_name ? `${v.user_name}: ` : "",
      }));
      await postVerdicts(dest, rows.map((row) => ({ ...row, reason: `${row.label}${row.reason}` })), `✅ Batch reviewed (${verdicts.length} post(s))`);

      // Discord-side actions for messages that were in this batch.
      for (const v of verdicts) {
        if (!v.postId || !v.postId.startsWith("discord_")) continue;
        const msgId = v.postId.slice("discord_".length);
        const msg = await channel.messages.fetch(msgId).catch(() => null);
        if (!msg) continue;
        if (v.action === "remove") {
          if (config.discordDeleteRemoved) {
            await msg.delete().catch(() => log(`[loop] could not delete ${msgId}`));
          }
          await sendViolationNotice(msg.author, msg.member, { category: v.category, reason: v.reason });
        }
        log(`[loop] ${msg.author.username}: ${v.action}/${v.category} (${msgId})`);
      }
      if (verdicts.length < 8) break; // batch smaller than max = queue likely drained
    }
  } finally {
    reviewLoopRunning = false;
  }
}

/** `!digest` — today's community-health report from the Mind. */
async function runDigest(channel) {
  let r;
  try {
    r = await api("/api/digest", {});
  } catch (err) {
    return channel.send(`⚠️ Digest failed: ${err.message}`);
  }
  const p = r.body.parsed;
  if (!p) return channel.send(`⚠️ Digest failed: ${r.body.error ?? "try again later"}`);
  const concerns = (p.concerns ?? []).map((c) => `  ⚠️ ${c}`).join("\n");
  return channel.send(
    `📊 Community health: **${p.healthScore ?? "?"}/100**\n${p.summary}\n${concerns}`
  );
}

// Command matcher: exact name, or name followed by a space (so
// "!reviewxyz" is a normal message, not a command).
const isCmd = (cmd, name) => cmd === `!${name}` || cmd.startsWith(`!${name} `);

function verdictLine(v) {
  return `${EMOJI[v.action] ?? "⚪"} ${v.action} — ${v.category} (${v.severity}) — ${v.reason}`;
}

async function postVerdicts(channel, rows, heading) {
  let text = heading;
  for (const row of rows) {
    const line = `\n${verdictLine(row)}`;
    if (text.length + line.length > MAX_LEN) {
      text += `\n… ${rows.length - rows.indexOf(row)} more not shown (message too long)`;
      break;
    }
    text += line;
  }
  await channel.send(text);
}

// ── commands ────────────────────────────────────────────────────────

/** `!review` — loop review rounds until the whole queue is drained. */
async function runFullReview(channel) {
  const all = [];
  for (let round = 1; round <= 10; round++) {
    let r;
    try {
      r = await api("/api/review", {});
    } catch {
      return channel.send("⚠️ Cannot reach the Hearthkeeper engine — is `npm start` running?");
    }
    if (r.body.skipped) {
      return channel.send(`⏳ A review is already running (${all.length} done so far). Try again in a minute.`);
    }
    if (r.body.error) {
      return channel.send(`⚠️ Round ${round}: Mind reply could not be parsed — batch moved to human review. ${r.body.error}`);
    }
    const verdicts = r.body.verdicts ?? [];
    all.push(...verdicts);
    if (verdicts.length === 0) break; // queue drained
    if (round > 1) await channel.send(`⏳ Round ${round}: ${verdicts.length} more reviewed…`);
  }
  if (all.length === 0) return channel.send("Queue is empty — nothing to review.");
  return postVerdicts(channel, all, `✅ Full review complete (${all.length} posts)`);
}

/** `!audit` — full sweep: queue → escalation review → health digest. */
async function runAudit(channel) {
  await channel.send("🛡️ Full audit started: queue → escalation → digest (each step takes 30–90 s)…");
  await runFullReview(channel);

  let esc;
  try {
    esc = await api("/api/escalate", {});
  } catch {
    return channel.send("⚠️ Escalation review failed — cannot reach the Hearthkeeper engine.");
  }
  if (esc.body.error) {
    await channel.send(`⚠️ Escalation review failed: ${esc.body.error}`);
  } else if (esc.body.escalated) {
    const lines = (esc.body.members ?? []).map((m) => `  ${m.userId} → **${m.action}** (${m.reason})`);
    await channel.send(`⚖️ Escalation review: ${esc.body.escalated} member(s)\n${lines.join("\n")}`);
  } else {
    await channel.send(`⚖️ Escalation review: ${esc.body.message ?? "no repeat offenders"}`);
  }

  let dig;
  try {
    dig = await api("/api/digest", {});
  } catch {
    return channel.send("⚠️ Digest failed — cannot reach the Hearthkeeper engine.");
  }
  const p = dig.body.parsed;
  if (p) {
    await channel.send(`📊 Community health: **${p.healthScore ?? "?"}/100**\n${p.summary}`);
  } else {
    await channel.send("⚠️ Digest failed, try again later.");
  }
  await channel.send("✅ Full audit complete.");
}

/** `!flagged` — list posts waiting for human review. */
async function listFlagged(channel) {
  let s;
  try {
    s = await api("/api/state");
  } catch {
    return channel.send("⚠️ Cannot reach the Hearthkeeper engine — is `npm start` running?");
  }
  const flagged = (s.body.decisions ?? []).filter((d) => d.action === "flag").slice(0, 8);
  if (flagged.length === 0) return channel.send("Nothing waiting for human review.");
  await channel.send(`🟡 **${flagged.length} post(s) awaiting human review** — rule with \`!decide <postId> allow|remove\``);
  for (const d of flagged.slice(0, 5)) {
    await channel.send(
      `**${d.post_id}** · ${d.user_name}\n> ${String(d.text ?? "").slice(0, 120)}\n> Reason: ${d.reason}`
    );
  }
  if (flagged.length > 5) await channel.send(`…${flagged.length - 5} more; newest ones listed first.`);
}

/** `!decide <postId> <allow|flag|remove> [note]` — human ruling. */
async function decide(message, cmd, dest) {
  const parts = cmd.split(/\s+/);
  const postId = parts[1];
  const to = parts[2];
  const note = parts.slice(3).join(" ");
  if (!postId || !["allow", "flag", "remove"].includes(to)) {
    return dest.send(
      "Usage: `!decide <postId> <allow|flag|remove> [note]`\nFind postIds with `!flagged`."
    );
  }
  try {
    const r = await api(`/api/decisions/${encodeURIComponent(postId)}/override`, { to, note });
    const p = r.body.post;
    if (!p) return dest.send(`⚠️ ${r.body.error ?? "Decision failed (post may have no ruling yet)"}`);
    await dest.send(
      `✅ Human ruling applied · **${p.user_name}** → ${EMOJI[p.action]} **${p.action}** (${p.category})\nReason: ${p.reason}`
    );
    log(`[discord] manual decide: ${postId} → ${to}`);
  } catch (err) {
    return dest.send(`⚠️ Decision failed: ${err.message}`);
  }
}

/** `!blacklist list|add|remove <term>` — manage the blacklist file. */
async function blacklist(message, cmd, dest) {
  const parts = cmd.split(/\s+/);
  const sub = parts[1];
  const term = parts.slice(2).join(" ").trim();

  if (sub === "list" || sub === undefined) {
    const terms = loadBlacklist();
    if (terms.length === 0) return dest.send("Blacklist is empty.");
    return dest.send(`📕 Blacklist (${terms.length} terms):\n${terms.map((t) => `• ${t}`).join("\n")}`);
  }
  if (!term) {
    return dest.send("Usage: `!blacklist add <term>` | `!blacklist remove <term>` | `!blacklist list`");
  }
  try {
    const res = sub === "add" ? addBlacklistTerm(term) : sub === "remove" ? removeBlacklistTerm(term) : null;
    if (!res) return dest.send("Usage: `!blacklist add <term>` | `!blacklist remove <term>` | `!blacklist list`");
    if (!res.ok) return dest.send(`⚠️ ${res.error}`);
    return dest.send(`✅ Blacklist updated: ${sub === "add" ? "added" : "removed"} \`${res.term}\` — takes effect immediately.`);
  } catch (err) {
    return dest.send(`⚠️ Blacklist update failed: ${err.message}`);
  }
}

/** `!bannedlist` — list blacklisted members. */
async function bannedList(dest) {
  const banned = loadBannedUsers();
  if (banned.length === 0) return dest.send("No members are blacklisted.");
  return dest.send(`⛔ Blacklisted members (${banned.length}):\n${banned.map((u) => `• ${u}`).join("\n")}`);
}

/**
 * `!banuser @member` — blacklist a member (their messages are removed
 * instantly from now on) and try to ban them from the server.
 */
async function banUser(message, dest) {
  const target = message.mentions.members?.first() ?? null;
  if (!target) return dest.send("Usage: `!banuser @member` — mention the member to blacklist.");
  const userId = `u_${target.id}`;
  const res = addBannedUser(userId);
  const lines = [];
  if (res.ok) lines.push(`⛔ Added **${target.user.tag}** to the blacklist. Their messages will be removed instantly.`);
  else lines.push(`⚠️ ${res.error}`);

  // Optionally also ban them from the server (needs Ban Members).
  try {
    await target.ban({ reason: "Hearthkeeper: member blacklisted by moderator" });
    lines.push(`🔨 Also banned **${target.user.tag}** from the server.`);
  } catch (err) {
    lines.push(`ℹ️ (Server ban failed — missing Ban Members permission? ${err.message})`);
  }
  log(`[banuser] ${target.user.tag} (${userId})`);
  return dest.send(lines.join("\n"));
}

/** `!unbanuser @member` — remove a member from the blacklist. */
async function unbanUser(message, dest) {
  const target = message.mentions.members?.first() ?? null;
  if (!target) return dest.send("Usage: `!unbanuser @member` — mention the member to unblacklist.");
  const userId = `u_${target.id}`;
  const res = removeBannedUser(userId);
  if (!res.ok) return dest.send(`⚠️ ${res.error}`);
  log(`[unbanuser] ${target.user.tag} (${userId})`);
  return dest.send(`✅ Removed **${target.user.tag}** from the blacklist. Their messages will be reviewed normally again.`);
}

/** `!whitelist list|add|remove <term>` — manage the whitelist file. */
async function whitelist(message, cmd, dest) {
  const parts = cmd.split(/\s+/);
  const sub = parts[1];
  const term = parts.slice(2).join(" ").trim();

  if (sub === "list" || sub === undefined) {
    const terms = loadWhitelist();
    if (terms.length === 0) return dest.send("Whitelist is empty.");
    return dest.send(`📗 Whitelist (${terms.length} terms):\n${terms.map((t) => `• ${t}`).join("\n")}`);
  }
  if (!term) {
    return dest.send("Usage: `!whitelist add <term>` | `!whitelist remove <term>` | `!whitelist list`");
  }
  try {
    const res = sub === "add" ? addWhitelistTerm(term) : sub === "remove" ? removeWhitelistTerm(term) : null;
    if (!res) return dest.send("Usage: `!whitelist add <term>` | `!whitelist remove <term>` | `!whitelist list`");
    if (!res.ok) return dest.send(`⚠️ ${res.error}`);
    return dest.send(`✅ Whitelist updated: ${sub === "add" ? "added" : "removed"} \`${res.term}\` — takes effect immediately.`);
  } catch (err) {
    return dest.send(`⚠️ Whitelist update failed: ${err.message}`);
  }
}

/** `!stats` — member violation stats. */
async function stats(channel) {
  let s;
  try {
    s = await api("/api/state");
  } catch {
    return channel.send("⚠️ Cannot reach the Hearthkeeper engine — is `npm start` running?");
  }
  const c = s.body.counts ?? {};
  const offenders = (s.body.users ?? [])
    .filter((u) => u.violations > 0)
    .sort((a, b) => b.violations - a.violations)
    .slice(0, 8);
  const lines = [
    `📊 **Stats** — ${c.total ?? 0} posts · ${c.decisions ?? 0} rulings`,
    `   pending ${c.pending ?? 0} · allowed ${c.approved ?? 0} · flagged ${c.flagged ?? 0} · removed ${c.removed ?? 0}`,
  ];
  if (offenders.length) {
    lines.push("**Top violators:**");
    for (const u of offenders) lines.push(`   ${u.violations}× ${u.name} (${u.status})`);
  } else {
    lines.push("No violators — clean community! 🎉");
  }
  return channel.send(lines.join("\n"));
}

/**
 * Private warning ladder — DM only the offending user can see:
 *   1st violation → gentle reminder (what happens if they continue)
 *   2nd violation → "muted 10 min" notice + actual 10-min timeout
 *   3rd+ violation → final ban warning (ban itself stays manual)
 * Uses the engine's violation count for the current user.
 */
async function sendViolationNotice(author, member, { category = "unknown", reason = "" }) {
  const userId = `u_${author.id}`;
  let violations = 1;
  try {
    const s = await api("/api/state");
    const user = (s.body.users ?? []).find((u) => u.id === userId);
    if (user) violations = user.violations;
  } catch { /* best-effort; default to 1 */ }

  const server = member?.guild?.name ?? "the community";
  const head = `Hi ${author.username}! This is an automated notice from **Hearthkeeper**, the AI community steward of *${server}*.`;
  const foot = "You're receiving this in private so no one else sees it. 💛";

  try {
    if (violations === 1) {
      await author.send(
        `${head}\n\nYour recent message was removed for violating our community rules (${category}: ${reason}).\n\n` +
        `This is your **first warning** — no action has been taken against your account. Please keep future messages kind and on-topic.\n\n` +
        `Please note: violations escalate automatically — a **2nd violation results in a 10-minute mute**, and a **3rd results in a ban** from the server.\n\n${foot}`
      );
      log(`[warn] 1st DM sent to ${author.username}`);
    } else if (violations === 2) {
      await author.send(
        `${head}\n\nYour recent message was removed (${category}: ${reason}). This is your **2nd violation**.\n\n` +
        `Per our escalation policy you have been **muted for 10 minutes** — you'll be able to chat again after that.\n\n` +
        `⚠️ One more violation will result in a **ban**. Please take a moment to re-read the community rules.\n\n${foot}`
      );
      log(`[warn] 2nd DM sent to ${author.username}`);
      // Actually mute for 10 minutes (needs "Timeout Members" permission).
      if (member?.timeout) {
        await member.timeout(MUTE_MS, `Hearthkeeper: 2nd violation (${category})`).catch((err) => {
          log(`[warn] timeout failed for ${author.username}: ${err.message} (missing Timeout Members?)`);
        });
      }
    } else {
      await author.send(
        `${head}\n\nYour recent message was removed (${category}: ${reason}). You now have **${violations} violations**.\n\n` +
        `🚫 This is your **final warning**: our policy is a **ban at ${BAN_THRESHOLD} violations**. If you break the rules again, you will be banned from the server.\n\n` +
        `The community is better with you in it — please stop and reset. 🙏\n\n${foot}`
      );
      log(`[warn] final DM sent to ${author.username}`);
    }
  } catch (err) {
    // User may have DMs disabled server-side — never crash the flow.
    log(`[warn] DM to ${author.username} failed: ${err.message}`);
  }
}

/**
 * `!enforce` — apply the latest escalation rulings to Discord itself.
 * Human-confirmed and destructive, so it never runs automatically:
 *   restrict → 10-min timeout (needs "Moderate Members")
 *   ban      → server ban (needs "Ban Members")
 * Usage: `!enforce` | `!enforce restrict` | `!enforce ban`
 */
async function enforce(message, cmd, dest) {
  const parts = cmd.split(/\s+/);
  const only = parts[1];
  if (only && !["restrict", "ban"].includes(only)) {
    return dest.send("Usage: `!enforce` | `!enforce restrict` | `!enforce ban`");
  }
  let s;
  try {
    s = await api("/api/state");
  } catch {
    return dest.send("⚠️ Cannot reach the Hearthkeeper engine — is `npm start` running?");
  }
  const escalations = (s.body.reports ?? []).filter((r) => r.kind === "escalation");
  const latest = escalations[0];
  if (!latest) return dest.send("No escalation report yet — run `!audit` first.");
  let rulings;
  try {
    rulings = JSON.parse(latest.body);
  } catch {
    return dest.send("⚠️ Could not read the escalation report.");
  }
  const targets = rulings.filter(
    (m) => m.action !== "warn" && (!only || m.action === only) && /^u_\d+$/.test(m.userId)
  );
  if (!targets.length) return dest.send("Nothing to enforce (no Discord restrict/ban rulings in the latest report).");

  const results = [];
  for (const m of targets) {
    const discordId = m.userId.slice(2);
    try {
      const member = await message.guild.members.fetch(discordId);
      if (m.action === "ban") {
        await member.ban({ reason: `Hearthkeeper: ${m.reason}` });
        results.push(`🔨 Banned **${member.user.tag}** — ${m.reason}`);
        log(`[enforce] banned ${member.user.tag} (${discordId})`);
      } else {
        await member.timeout(MUTE_MS, `Hearthkeeper: ${m.reason}`);
        results.push(`⏱️ Timed out 10min **${member.user.tag}** — ${m.reason}`);
        log(`[enforce] timeout ${member.user.tag} (${discordId})`);
      }
    } catch (err) {
      results.push(`⚠️ ${m.userId}: ${err.message}`);
      log(`[enforce] FAILED ${m.userId}: ${err.message}`);
    }
  }
  return dest.send(`**Enforcement complete**\n${results.join("\n")}`);
}

// ── event handling ──────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  log(`Discord bot online as ${c.user.tag}`);
  log(`Watching channels: ${config.discordChannelIds.length ? config.discordChannelIds.join(", ") : "ALL channels"}`);
  log(`Auto-delete on "remove": ${config.discordDeleteRemoved ? "ON" : "OFF"}`);
  if (config.discordOutputChannelId) {
    try {
      outChannel = await client.channels.fetch(config.discordOutputChannelId);
      log(`All bot output → channel "${outChannel?.name ?? config.discordOutputChannelId}"`);
    } catch (err) {
      log(`⚠ Could not find DISCORD_OUTPUT_CHANNEL_ID — falling back to same-channel replies: ${err.message}`);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (config.discordChannelIds.length && !config.discordChannelIds.includes(message.channel.id)) return;

  // All bot/Mind output goes to the configured output channel when set.
  const dest = outChannel ?? message.channel;
  const cmd = message.content.trim();

  // ── commands ──────────────────────────────────────────────────────
  if (cmd.startsWith("!help") || cmd === "!") {
    return dest.send(
      "**Hearthkeeper commands**\n" +
      "`!review` — review the whole queue\n" +
      "`!audit` — queue + escalation + health digest\n" +
      "`!flagged` — posts awaiting human review\n" +
      "`!decide <postId> <allow|flag|remove> [note]` — human ruling (taught to the Mind)\n" +
      "`!blacklist add|remove|list <term>` — manage the auto-delete dictionary\n" +
      "`!whitelist add|remove|list <term>` — manage the safe-word dictionary\n" +
      "`!banuser @member` — blacklist a member (messages removed instantly)\n" +
      "`!unbanuser @member` — remove from blacklist\n" +
      "`!bannedlist` — list blacklisted members\n" +
      "`!stats` — violation stats\n" +
      "`!digest` — today's health report\n" +
      "`!enforce` — apply restrict/ban rulings to Discord (timeout/ban)"
    );
  }
  if (isCmd(cmd, "review")) return runFullReview(dest);
  if (isCmd(cmd, "audit")) return runAudit(dest);
  if (isCmd(cmd, "flagged")) return listFlagged(dest);
  if (isCmd(cmd, "decide")) return decide(message, cmd, dest);
  if (isCmd(cmd, "blacklist")) return blacklist(message, cmd, dest);
  if (isCmd(cmd, "whitelist")) return whitelist(message, cmd, dest);
  if (isCmd(cmd, "banuser")) return banUser(message, dest);
  if (isCmd(cmd, "unbanuser")) return unbanUser(message, dest);
  if (isCmd(cmd, "bannedlist")) return bannedList(dest);
  if (isCmd(cmd, "stats")) return stats(dest);
  if (isCmd(cmd, "digest")) return runDigest(dest);
  if (isCmd(cmd, "enforce")) return enforce(message, cmd, dest);

  // ── regular message → moderation pipeline ─────────────────────────
  try {
    const postId = `discord_${message.id}`;
    const queued = await api("/api/webhook", {
      id: postId,
      userId: `u_${message.author.id}`,
      userName: message.author.username,
      channel: message.channel.name ?? "discord",
      text: message.content.slice(0, 4000),
    });
    if (queued.status !== 201) {
      log(`[discord] queue failed (${queued.status}) for ${message.id}`);
      return;
    }

    // Blacklist hit → the engine already removed it; delete it now.
    const hits = queued.body.blacklisted ?? [];
    const hit = hits.find((h) => h.id === postId);
    if (hit) {
      await message.delete().catch(() => log(`[discord] could not delete ${message.id}`));
      await dest.send(
        `🔴 Removed **${message.author.username}**'s message — **blacklisted term** (${hit.category}).\nReason: ${hit.reason}`
      ).catch(() => {});
      log(`[discord] ${message.author.username}: BLACKLIST auto-remove (${hit.matchedTerm})`);
      // Private warning ladder (1st → reminder, 2nd → 10-min mute, 3rd → ban warning)
      await sendViolationNotice(message.author, message.member, { category: hit.category, reason: hit.reason });
      return;
    }

    // Flood hit → instant remove + warning (no Mind call needed).
    const floods = queued.body.flooded ?? [];
    const flood = floods.find((f) => f.id === postId);
    if (flood) {
      await message.delete().catch(() => log(`[discord] could not delete ${message.id}`));
      await dest.send(
        `🔴 Removed **${message.author.username}**'s message — **message flood**.\nReason: ${flood.reason}`
      ).catch(() => {});
      log(`[discord] ${message.author.username}: FLOOD auto-remove`);
      await sendViolationNotice(message.author, message.member, { category: flood.category, reason: flood.reason });
      return;
    }

    // Normal path: every queued message is guaranteed a ruling — the
    // review loop waits out in-flight rounds and drains the whole queue,
    // posting verdicts in batches (no more silently skipped messages).
    await ensureReviewLoop(message.channel, dest);
  } catch (err) {
    log(`[discord] error: ${err.message}`);
    dest.send("⚠️ Hearthkeeper engine not reachable — run `npm start` first.").catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.user.bot) return;

    // Welcome channel: configured ID, else the server's system channel.
    let channel = null;
    if (config.discordWelcomeChannelId) {
      channel = await client.channels.fetch(config.discordWelcomeChannelId).catch(() => null);
    }
    if (!channel) channel = member.guild.systemChannel;
    if (!channel || !channel.isTextBased()) {
      log(`[welcome] no text welcome channel for ${member.user.username} (set DISCORD_WELCOME_CHANNEL_ID)`);
      return;
    }

    const name = member.user.username;
    let message = `Welcome to the server, ${name}! 🎉`;
    // Let the Mind write the welcome (it greets BY NAME). Falls back to
    // the template if the Mind is slow or unreachable.
    try {
      const r = await api("/api/chat", {
        text: `A new member named "${name}" just joined the "${member.guild.name}" community. Write a short, warm welcome message (2-3 sentences) that greets them BY NAME and fits a friendly art-sharing community. Reply with ONLY the welcome message, no markdown.`,
      });
      if (r.body.reply) message = r.body.reply;
    } catch (err) {
      log(`[welcome] Mind unavailable for ${name}, using template: ${err.message}`);
    }

    await channel.send(message);
    log(`[welcome] welcomed ${name} in #${channel.name ?? channel.id}`);
  } catch (err) {
    log(`[welcome] failed: ${err.message}`);
  }
});

client.login(config.discordToken).catch((err) => {
  console.error(`✖ Discord login failed: ${err.message}`);
  process.exit(1);
});

function shutdown() {
  log("Discord bot shutting down…");
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
