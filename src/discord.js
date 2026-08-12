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
  addWhitelistTerm, removeWhitelistTerm,
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
  ],
});

const API = `http://localhost:${config.port}`;
const EMOJI = { allow: "🟢", flag: "🟡", remove: "🔴" };
const MAX_LEN = 1900; // Discord message limit (2000) minus headroom

// When DISCORD_OUTPUT_CHANNEL_ID is set, ALL bot/Mind output is sent
// there instead of the channel the message came from.
let outChannel = null;

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
      "`!stats` — violation stats\n" +
      "`!digest` — today's health report"
    );
  }
  if (isCmd(cmd, "review")) return runFullReview(dest);
  if (isCmd(cmd, "audit")) return runAudit(dest);
  if (isCmd(cmd, "flagged")) return listFlagged(dest);
  if (isCmd(cmd, "decide")) return decide(message, cmd, dest);
  if (isCmd(cmd, "blacklist")) return blacklist(message, cmd, dest);
  if (isCmd(cmd, "whitelist")) return whitelist(message, cmd, dest);
  if (isCmd(cmd, "stats")) return stats(dest);
  if (isCmd(cmd, "digest")) return runDigest(dest);

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
      return;
    }

    const review = await api("/api/review", {});
    if (review.body.skipped) {
      // Another review is running (scheduler or manual) — verdicts will
      // still land in the audit log; don't spam the channel.
      return;
    }
    const verdicts = review.body.verdicts ?? [];
    const mine = verdicts.filter((v) => v.postId === postId);
    if (!mine.length) return; // this message wasn't in the batch

    const v = mine[0];
    await dest.send(
      `✅ Review complete · **${message.author.username}**\nVerdict: ${EMOJI[v.action]} **${v.action}** (${v.category} / ${v.severity})\nReason: ${v.reason}`
    );
    log(`[discord] ${message.author.username}: ${v.action}/${v.category} (${message.id})`);

    if (v.action === "remove" && config.discordDeleteRemoved) {
      await message.delete().catch(() => log(`[discord] could not delete ${message.id} (missing Manage Messages?)`));
    }
  } catch (err) {
    log(`[discord] error: ${err.message}`);
    dest.send("⚠️ Hearthkeeper engine not reachable — run `npm start` first.").catch(() => {});
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
