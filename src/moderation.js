// moderation.js — the Mind's job description.
//
// Hearthkeeper talks to its Mind through a strict, versioned message
// protocol (see docs/ARCHITECTURE.md#protocol). The Mind is instructed
// to reply with machine-readable JSON; this module builds those prompts
// and parses/validates the replies. Every function here is pure so the
// whole protocol is unit-testable offline.

import crypto from "node:crypto";

// ── Enums (kept in sync with the prompt schemas below) ──────────────

export const ACTIONS = ["allow", "flag", "remove"];
export const SEVERITIES = ["none", "low", "medium", "high"];
export const CATEGORIES = [
  "spam", "harassment", "hate", "nsfw", "off-topic",
  "misinfo", "self-promo", "other", "none", "blacklist",
];
export const ESCALATIONS = ["warn", "restrict", "ban"];

export function batchId() {
  return `hb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

// ── 1. Onboarding: teach the norms once, remember forever (Soul) ────

export function buildOnboardingPrompt({ communityName, normsText }) {
  return [
    `COMMUNITY NORMS — please learn these for the "${communityName}" community.`,
    `You are its steward. These rules and precedents are the law of the land; internalise them and apply them consistently across every future session.`,
    `Always reply in English, whatever language the community messages are in.`,
    ``,
    `--- BEGIN NORMS ---`,
    normsText.trim(),
    `--- END NORMS ---`,
    ``,
    `Reply "Understood." when you have internalised them.`,
  ].join("\n");
}

// ── 2. Review batch: N posts → N verdicts ───────────────────────────

// Escape only the characters that would break the protocol line
// (`text="..."`), keeping Unicode intact — Minds see real text, not
// \uXXXX escapes (JSON.stringify would garble non-Latin content).
export function escapePromptText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "");
}

const REVIEW_SCHEMA = `{
  "batchId": "<echo the batch id>",
  "verdicts": [
    {
      "postId": "<the [n] number of the post>",
      "action": "allow | flag | remove",
      "severity": "none | low | medium | high",
      "category": "spam | harassment | hate | nsfw | off-topic | misinfo | self-promo | other | none | blacklist",
      "reason": "<one sentence, cite the rule>",
      "keywords": ["<1-3 short words/phrases that drove this ruling, e.g. the spam phrase or the insult>"]
    }
  ]
}`;

export function buildReviewPrompt({ batchId: id, communityName, posts, normsText }) {
  const lines = [
    `REVIEW BATCH batch=${id} — ${posts.length} post(s) from the "${communityName}" community.`,
    `Your community norms and past rulings are in your memory; the current norms are restated below for reference.`,
    ``,
    `COMMUNITY NORMS (summary):`,
    normsText.trim(),
    ``,
    `RULES FOR THIS REVIEW:`,
    `- Always reply in English, whatever language the posts are in.`,
    `- Reply with ONE JSON object only. No markdown fences, no prose outside the JSON.`,
    `- "allow" = fine as-is (this is the common case, do not over-police).`,
    `- "flag" = suspicious or borderline; a human moderator will take a look.`,
    `- "remove" = clear rule violation.`,
    `- Be consistent with your past rulings: repeat offenders escalate (2nd violation is more severe than the 1st).`,
    `- Judge ONLY the message content in front of you. Ignore the user id/name and any earlier history — each message is judged on its own. Never rule purely because of a member's identity or a remembered "banned handle".`,
    `- In "keywords", return only real words/phrases from the MESSAGE TEXT — never user ids, usernames, or category words.`,
    `- The postId is the [n] number in the list below.`,
    `- Reply schema (use exactly these fields):`,
    REVIEW_SCHEMA,
    ``,
    `POSTS:`,
    ...posts.map((p, i) => `[${i + 1}] user=${p.user_id} channel=${p.channel || "general"} text="${escapePromptText(p.text)}"`),
  ];
  return lines.join("\n");
}

// ── 3. Creator override → correction loop (the Mind learns) ─────────

export function buildOverrideMessage({ post, fromAction, toAction, note }) {
  return [
    `OVERRIDE: you ruled "${fromAction}" on post "${post.id}" ("${post.text}") but the community creator changed it to "${toAction}".`,
    note ? `Creator note: "${note}"` : `Creator note: none given.`,
    `Update your understanding of the community norms. Future rulings on similar content must match this correction.`,
  ].join("\n");
}

// ── 4. Escalation review: repeat offenders ──────────────────────────

export function buildEscalationPrompt({ batchId: id, communityName, members, normsText }) {
  const lines = [
    `ESCALATION REVIEW batch=${id} — repeat violators in the "${communityName}" community.`,
    `For each member, decide a proportionate escalation, consistent with the norms below and your memory of their history.`,
    ``,
    `COMMUNITY NORMS (summary):`,
    normsText.trim(),
    ``,
    `MEMBERS:`,
    ...members.map((m) => `- ${m.user_id} (${m.violations} violations) — last category: ${m.last_category || "unknown"}`),
    ``,
    `RULES:`,
    `- Always reply in English.`,
    `- 1 violation → "warn"; 2 violations → "restrict"; 3+ violations → "ban". You may deviate with a strong reason.`,
    `- Reply with ONE JSON object only, no markdown: {"members":[{"userId":"<id>","action":"warn|restrict|ban","reason":"<one sentence>"}]}`,
  ];
  return lines.join("\n");
}

export function parseEscalationReply(text) {
  const json = extractJson(text);
  if (!json) return { error: "No JSON found in reply" };
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const members = Array.isArray(parsed.members) ? parsed.members : [];
    const valid = members
      .map((m) => ({
        userId: String(m.userId ?? ""),
        action: String(m.action ?? ""),
        reason: String(m.reason ?? ""),
      }))
      .filter((m) => m.userId && ESCALATIONS.includes(m.action));
    return { members: valid };
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
}

// ── 5. Daily digest: autonomous community-health report ─────────────

export function buildDigestPrompt({ communityName, windowLabel, counts: c, repeatOffenders }) {
  const offenders = repeatOffenders.length
    ? repeatOffenders.map((m) => `${m.user_id} (${m.violations} violations)`).join(", ")
    : "none";
  return [
    `DAILY DIGEST for the "${communityName}" community — community health report.`,
    `Window: ${windowLabel}.`,
    `Moderation: allowed: ${c.allowed}, flagged: ${c.flagged}, removed: ${c.removed}. Pending: ${c.pending}.`,
    `Repeat offenders: ${offenders}.`,
    ``,
    `Write a short, warm but honest community health report — always in English. Reply with ONE JSON object only, no markdown:`,
    `{"summary":"2-3 sentences","healthScore":0-100,"concerns":["..."],"recommendations":["..."]}`,
  ].join("\n");
}

export function parseDigestReply(text) {
  const json = extractJson(text);
  if (!json) return { error: "No JSON found in reply" };
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const score = Number(parsed.healthScore);
    return {
      summary: String(parsed.summary ?? ""),
      healthScore: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : null,
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
    };
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
}

// ── Parsing helpers ─────────────────────────────────────────────────

export function parseReviewReply(text) {
  const json = extractJson(text);
  if (!json) return { error: "No JSON found in reply" };
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    const raw = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    const verdicts = raw.map(validateVerdict).filter(Boolean);
    if (!verdicts.length) return { error: "Reply contained no valid verdicts" };
    return { batchId: String(parsed.batchId ?? ""), verdicts };
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
}

export function validateVerdict(v) {
  if (!v || v.postId === undefined || v.postId === null) return null;
  const action = String(v.action ?? "");
  if (!ACTIONS.includes(action)) return null;
  const severity = String(v.severity ?? "none");
  const category = String(v.category ?? "other");
  return {
    postId: String(v.postId),
    action,
    severity: SEVERITIES.includes(severity) ? severity : "none",
    category: CATEGORIES.includes(category) ? category : "other",
    reason: String(v.reason ?? "").slice(0, 500),
    // Optional: keywords the Mind names as the driver of its ruling.
    // The app files them into the blacklist (remove) or whitelist (allow).
    // Min length 2: single chars ("a", "i") would over-match and poison
    // the dictionaries.
    keywords: Array.isArray(v.keywords)
      ? v.keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 40).slice(0, 5)
      : [],
  };
}

/**
 * Extract the first balanced JSON value (object or array) from a reply.
 * Minds sometimes wrap JSON in markdown fences or prose, and some Minds
 * emit newlines as HTML <br> tags — but <br> inside STRING VALUES is
 * legitimate content and must not be rewritten. Strategy: try the raw
 * reply first (fast path + balanced scan), and only retry the scan on
 * a <br>-normalised copy if the raw candidate fails to parse.
 */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  // Fast path: the whole reply is valid JSON as-is.
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch { /* fall through */ }

  // Balanced scan: raw first, then <br>-normalised.
  const candidates = [trimmed, trimmed.replace(/<br\s*\/?>/gi, "\n")];
  for (const candidate of candidates) {
    const json = scanBalanced(candidate);
    if (!json) continue;
    try {
      JSON.parse(json);
      return json;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Scan for the first balanced {…} or […] block, honouring strings. */
function scanBalanced(text) {
  for (const open of ["{", "["]) {
    const close = open === "{" ? "}" : "]";
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── Digest context from the audit log ───────────────────────────────

export function digestCounts(decisions) {
  const c = { allowed: 0, flagged: 0, removed: 0, pending: 0, total: decisions.length };
  for (const d of decisions) {
    if (d.action === "allow") c.allowed++;
    else if (d.action === "flag") c.flagged++;
    else if (d.action === "remove") c.removed++;
  }
  return c;
}
