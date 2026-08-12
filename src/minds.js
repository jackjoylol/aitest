// minds.js — the Minds integration layer.
//
// Wraps the official Minds Builder client library
// (@animocabrands/minds-client-lib) behind one small interface, and
// provides a deterministic offline MOCK of the same interface so the
// whole product can be demoed before a Minds account exists.
//
// The Mind is the brain of Hearthkeeper: every moderation verdict,
// escalation and digest comes from the Mind. This module is the only
// place that talks to it.

import config from "./config.js";

export class MindError extends Error {
  constructor(message, { status = null, code = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "MindError";
    this.status = status;
    this.code = code;
  }
}

// ────────────────────────────────────────────────────────────────────
// Real Minds client (lazy import so mock mode never needs the package)
// ────────────────────────────────────────────────────────────────────

let realLibPromise = null;
async function realLib() {
  if (!realLibPromise) {
    realLibPromise = import("@animocabrands/minds-client-lib").then((m) => {
      if (!config.builderApiKey) {
        throw new MindError(
          "MINDS_BUILDER_API_KEY is not set. Create a Builder API key in the Minds console, or run with HEARTHKEEPER_MOCK=1 for offline demo mode.",
          { code: "missing_builder_api_key" }
        );
      }
      return m;
    });
  }
  return realLibPromise;
}

// ────────────────────────────────────────────────────────────────────
// Mock Mind — a deterministic stand-in so the product runs with zero
// credentials. Same verdict schema, same conversation/history shape,
// and a module-level "memory" that mimics Soul continuity (it remembers
// repeat offenders across calls and even across app restarts within a
// process run).
// ────────────────────────────────────────────────────────────────────

const SPAM_TOKENS = [
  "free crypto", "airdrop", "100x", "claim your", "vip", "winner",
  "dm me", "referral", "buy now", "limited offer", "check out my nft",
  "onlyfans", "click here", "earn money", "get rich", "giveaway",
];
const HATE_TOKENS = ["faggot", "chink", "kike", "nigger", "retard", "spic", "tranny"];
const INSULT_TOKENS = ["trash", "stupid", "idiot", "dumb", "uninstall", "useless", "suck", "hate you", "kill yourself"];
const NSFW_TOKENS = ["porn", "nude", "sex", "nsfw", "dick", "cock", "cum"];

function mockVerdict(post, violations) {
  const text = (post.text || "").trim();
  const lower = text.toLowerCase();
  const isUrlOnly = /^https?:\/\/\S+$/i.test(text);

  let action = "allow";
  let severity = "none";
  let category = "none";
  let reason = "On-topic and respectful.";

  if (isUrlOnly || (SPAM_TOKENS.filter((t) => lower.includes(t)).length >= 1 && text.length < 120)) {
    action = "remove"; severity = "high"; category = "spam";
    reason = "Spam: link-only or promotional content.";
  } else if (HATE_TOKENS.some((t) => lower.includes(t))) {
    action = "remove"; severity = "high"; category = "hate";
    reason = "Hate speech: zero-tolerance violation.";
  } else if (lower.includes("kill yourself")) {
    action = "remove"; severity = "high"; category = "harassment";
    reason = "Harassment: threatening language.";
  } else if (NSFW_TOKENS.filter((t) => lower.includes(t)).length >= 2) {
    action = "flag"; severity = "medium"; category = "nsfw";
    reason = "Possible NSFW content, needs a human look.";
  } else if (INSULT_TOKENS.some((t) => lower.includes(t))) {
    action = "flag"; severity = "medium"; category = "harassment";
    reason = "Negativity toward a member; borderline harassment.";
  } else if (SPAM_TOKENS.some((t) => lower.includes(t))) {
    action = "flag"; severity = "low"; category = "spam";
    reason = "Possible promotion; verify intent.";
  } else if (/[A-Z]/.test(text) && text.replace(/[^A-Z]/g, "").length / Math.max(text.length, 1) > 0.7 && text.length > 18) {
    action = "flag"; severity = "low"; category = "spam";
    reason = "ALL-CAPS shouting, likely spam.";
  }

  // Soul-like memory: repeat offenders get escalated (2nd offense = harsher).
  if (action !== "allow" && violations >= 1) {
    if (action === "flag") action = "remove";
    severity = "high";
    reason = `${reason} Repeat offender (${violations} prior violation(s)).`;
  }
  return { action, severity, category, reason };
}

function createMock() {
  const memory = new Map(); // userId -> violation count (the "Soul")
  const history = [];
  let fingerprintSeq = 0;
  const now = () => new Date().toISOString();
  const push = (senderType, messageText) => {
    const row = { senderType, messageText, fingerprint: `mock-${++fingerprintSeq}`, createdAt: now() };
    history.push(row);
    return row;
  };

  return {
    mode: "mock",
    mindId: "mock-mind-001",
    async ensureConversation() {
      return { alias: config.alias, mindId: this.mindId, id: "mock-conv-001" };
    },
    async sendMessage({ messageText }) {
      return push(1, messageText);
    },
    async waitForReply({ sentMessageText }) {
      // Interpret what the mock "would have" been asked, then answer.
      let replyText;
      const batchId = (sentMessageText.match(/batch=([\w-]+)/) || [])[1] || "unknown";

      if (sentMessageText.includes("REVIEW BATCH")) {
        // Protocol: posts are listed as  [n] user=<id> channel=<c> text="..."
        // The verdict postId is the bracket index n (the app resolves it).
        const verdicts = [];
        const byIndex = [];
        for (const m of sentMessageText.matchAll(/\[(\d+)\]\s*user=(\S+)\s*channel=(\S+)\s*text="((?:[^"\\]|\\.)*)"/g)) {
          const [, index, userId, channel, text] = m;
          const text2 = text.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
          const violations = memory.get(userId) ?? 0;
          const v = mockVerdict({ text: text2 }, violations);
          verdicts.push({ postId: index, action: v.action, severity: v.severity, category: v.category, reason: v.reason });
          byIndex.push({ index, userId });
        }
        replyText = JSON.stringify({ batchId, verdicts });

        // Update mock Soul memory (repeat-offender tracking).
        try {
          for (const v of verdicts) {
            if (v.action === "allow") continue;
            const hit = byIndex.find((b) => b.index === v.postId);
            if (hit) memory.set(hit.userId, (memory.get(hit.userId) ?? 0) + 1);
          }
        } catch { /* ignore */ }
      } else if (sentMessageText.includes("ESCALATION REVIEW")) {
        // Protocol: members listed as  - <userId> (<n> violations)
        const members = [];
        for (const m of sentMessageText.matchAll(/- (\S+) \((\d+) violations\)/g)) {
          const [, userId, count] = m;
          const n = Number(count);
          members.push({ userId, action: n >= 3 ? "ban" : n === 2 ? "restrict" : "warn", reason: `${n} violations in the review window.` });
        }
        replyText = JSON.stringify({ members });
      } else if (sentMessageText.includes("DAILY DIGEST")) {
        // Protocol: digest context line "allowed: N, flagged: N, removed: N"
        const removed = (sentMessageText.match(/removed:\s*(\d+)/) || [])[1] ?? "0";
        const flagged = (sentMessageText.match(/flagged:\s*(\d+)/) || [])[1] ?? "0";
        const allowed = (sentMessageText.match(/allowed:\s*(\d+)/) || [])[1] ?? "0";
        const total = Number(removed) + Number(flagged) + Number(allowed);
        const health = total === 0 ? 90 : Math.max(40, Math.round(90 - Number(removed) * 6 - Number(flagged) * 2));
        replyText = JSON.stringify({
          summary: `Pinewood Forest is healthy today: ${allowed} posts allowed, ${flagged} flagged for review, ${removed} removed.`,
          healthScore: health,
          concerns: Number(removed) > 0 ? ["Spam is the top violation category today."] : [],
          recommendations: Number(removed) >= 3 ? ["Consider tightening the self-promo rule."] : [],
        });
      } else if (sentMessageText.startsWith("OVERRIDE")) {
        replyText = "Noted. I have updated my understanding of the community norms.";
      } else if (sentMessageText.includes("COMMUNITY NORMS")) {
        replyText = "Understood. I have internalised the community norms and precedents.";
      } else {
        replyText = "Hello! I am the Hearthkeeper steward for this community. Ask me about moderation decisions.";
      }

      const row = push(0, replyText);
      return { reply: row, timedOut: false };
    },
    async getHistory(_alias, { after = null, limit = 50 } = {}) {
      let rows = history;
      if (after) {
        const idx = rows.findIndex((r) => r.fingerprint === after);
        if (idx >= 0) rows = rows.slice(idx + 1);
      }
      return rows.slice(-limit);
    },
    async getLatestHistoryFingerprint() {
      return history.at(-1)?.fingerprint ?? null;
    },
    async getMindIdForAlias() {
      return this.mindId;
    },
    async listMinds() {
      return [{ mindId: this.mindId, name: "Hearthkeeper Steward (mock)", model: "heuristic-v1", species: "steward" }];
    },
    async getMind() {
      return { mindId: this.mindId, name: "Hearthkeeper Steward (mock)", model: "heuristic-v1", species: "steward", isEnabled: true, email: "steward@mock.local" };
    },
    async getCognitionBalance() {
      return { cognition: 999_999 };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Client factory
// ────────────────────────────────────────────────────────────────────

let instancePromise = null;

/** Get the singleton Minds client (real or mock). */
export async function getMinds() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (config.mock) {
        const mock = createMock();
        await mock.ensureConversation();
        return mock;
      }
      const lib = await realLib();
      const client = lib.createMindsClient({ builderApiKey: config.builderApiKey });
      return wrapReal(client);
    })();
  }
  return instancePromise;
}

/** Reset the singleton (used by tests). */
export function resetMinds() {
  instancePromise = null;
}

// Adapt the official client to our narrow interface + defensive shapes.
function wrapReal(client) {
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw new MindError(err?.message ?? String(err), {
        status: err?.status ?? null,
        code: err?.code ?? null,
        cause: err,
      });
    }
  };

  const normalizeRow = (r) => ({
    senderType: r?.senderType,
    messageText: r?.messageText ?? r?.text ?? "",
    fingerprint: r?.fingerprint ?? null,
    createdAt: r?.createdAt ?? r?.timestamp ?? null,
  });

  return {
    mode: "real",
    mindId: config.mindId, // may be null until resolved
    ensureConversation: guard(async (alias, mindId) => client.ensureConversation(alias, mindId)),
    sendMessage: guard(async ({ alias, messageText, attachments }) => client.sendMessage({ alias, messageText, attachments })),
    waitForReply: guard(async ({ alias, timeoutMs, afterFingerprint, sentMessageText }) => {
      const outcome = await client.waitForReply({ alias, timeoutMs, afterFingerprint, sentMessageText });
      return { reply: outcome?.reply ? normalizeRow(outcome.reply) : null, timedOut: outcome?.timedOut ?? false };
    }),
    getHistory: guard(async (alias, opts = {}) => {
      const rows = await client.getHistory(alias, opts);
      return (rows ?? []).map(normalizeRow);
    }),
    getLatestHistoryFingerprint: guard(async (alias) => client.getLatestHistoryFingerprint(alias)),
    getMindIdForAlias: guard(async (alias) => client.getMindIdForAlias(alias)),
    listMinds: guard(async () => {
      const res = await client.listMinds();
      return Array.isArray(res) ? res : res?.items ?? [];
    }),
    getMind: guard(async (mindId) => client.getMind(mindId)),
    getCognitionBalance: guard(async (mindId) => {
      const balance = await client.getCognitionBalance(mindId);
      return { cognition: balance?.cognition ?? balance ?? null };
    }),
  };
}

/**
 * Resolve the Mind we operate on: explicit MIND_ID, else the first Mind
 * on the account. Returns { mindId, name, model }.
 */
export async function resolveMind(minds) {
  if (minds.mindId) {
    const detail = await minds.getMind(minds.mindId).catch(() => null);
    return { mindId: minds.mindId, name: detail?.name ?? "Mind", model: detail?.model ?? null };
  }
  const list = await minds.listMinds();
  if (!list.length) {
    throw new MindError(
      "No Minds found on this account. Create a Mind at hellominds.ai/profile first (see docs/MIND_SETUP.md)."
    );
  }
  const first = list[0];
  minds.mindId = first.mindId;
  return { mindId: first.mindId, name: first.name ?? "Mind", model: first.model ?? null };
}
