// Hearthkeeper — central configuration.
// All values come from the environment (see .env.example).

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config = {
  // Minds
  builderApiKey: process.env.MINDS_BUILDER_API_KEY?.trim() || null,
  mindId: process.env.MIND_ID?.trim() || null, // null = auto-select first Mind
  alias: process.env.HEARTHKEEPER_ALIAS?.trim() || "hearthkeeper-main",

  // App
  mock: ["1", "true", "yes"].includes((process.env.HEARTHKEEPER_MOCK ?? "").toLowerCase()),
  port: int(process.env.PORT, 4173),
  dbPath: path.resolve(ROOT, process.env.DB_PATH?.trim() || "data/hearthkeeper.db"),
  webhookToken: process.env.WEBHOOK_TOKEN?.trim() || null,
  communityName: process.env.HEARTHKEEPER_COMMUNITY?.trim() || "Pinewood Forest",

  // Review batching
  batchSize: int(process.env.REVIEW_BATCH_SIZE, 8),
  replyTimeoutMs: int(process.env.MIND_REPLY_TIMEOUT_MS, 180_000),

  // Schedules
  autoReviewMinPending: int(process.env.AUTO_REVIEW_MIN_PENDING, 3),
  autoReviewCron: process.env.AUTO_REVIEW_CRON?.trim() || "*/15 * * * *",
  digestCron: process.env.DIGEST_CRON?.trim() || "0 9 * * *",
  escalationCron: process.env.ESCALATION_CRON?.trim() || "0 10 * * *",

  // Discord bot (see docs/DISCORD.md)
  discordToken: process.env.DISCORD_TOKEN?.trim() || null,
  discordChannelIds: (process.env.DISCORD_CHANNEL_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  discordOutputChannelId: process.env.DISCORD_OUTPUT_CHANNEL_ID?.trim() || null,
  discordWelcomeChannelId: process.env.DISCORD_WELCOME_CHANNEL_ID?.trim() || null,
  discordDeleteRemoved: ["1", "true", "yes"].includes((process.env.DISCORD_DELETE_REMOVED ?? "").toLowerCase()),

  // Instant blacklist / whitelist (see blacklist.txt / whitelist.txt)
  blacklistPath: path.resolve(ROOT, process.env.BLACKLIST_PATH?.trim() || "blacklist.txt"),
  whitelistPath: path.resolve(ROOT, process.env.WHITELIST_PATH?.trim() || "whitelist.txt"),
  // Banned members (see banned_users.txt) — their messages are removed instantly.
  bannedUsersPath: path.resolve(ROOT, process.env.BANNED_USERS_PATH?.trim() || "banned_users.txt"),

  // Link guard (廣告/邀請連結攔截) — see allowed_domains.txt.
  allowedDomainsPath: path.resolve(ROOT, process.env.ALLOWED_DOMAINS_PATH?.trim() || "allowed_domains.txt"),
  // New-member cooldown (minutes): members who joined less than this
  // long ago have external links blocked / held for review.
  newbieCooldownMinutes: int(process.env.NEWBIE_COOLDOWN_MINUTES, 1440), // 1440m = 24h
  // Hold-in-review is the default for newbie content; for normal members
  // an external link is removed instantly (could also hold for review).
  holdNewbieForReview: ["1", "true", "yes"].includes((process.env.HOLD_NEWBIE_FOR_REVIEW ?? "1").toLowerCase()),

  // Flood guard: same member posting more than floodMax messages within
  // floodWindowMs is auto-removed as spam.
  floodWindowMs: int(process.env.FLOOD_WINDOW_MS, 10_000),
  floodMax: int(process.env.FLOOD_MAX, 5),

  // Community norms — loaded by the app and taught to the Mind at
  // onboarding. Edit norms/community.md to match your community.
  normsPath: path.resolve(ROOT, "norms/community.md"),
};

export default config;
