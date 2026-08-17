// blacklist.js / whitelist.js — instant deterministic moderation.
//
// BLACKLIST: a message containing a blacklisted term is removed
// instantly on ingest — no Mind call, no waiting.
// WHITELIST: a message containing a whitelisted term is allowed
// instantly — no Mind call, protects known-safe vocabulary.
// Blacklist wins over whitelist (safety first).
//
// The Mind can extend both dictionaries automatically: when it rules on
// a post it may return `keywords` in its verdict; the app files them
// into the blacklist (action=remove) or whitelist (action=allow).
//
// Files are re-read on every check, so edits take effect immediately.
// Format: one term per line, `#` starts a comment. Matching is
// case-insensitive substring matching (English and Chinese).

import fs from "node:fs";
import config from "./config.js";

export function loadTerms(path) {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export const loadBlacklist = (path) => loadTerms(path ?? config.blacklistPath);
export const loadWhitelist = (path) => loadTerms(path ?? config.whitelistPath);

// Escape regex special chars in a term before building the matcher.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matching rules:
 *  - Pure-word ASCII terms ("sb", "fuck you") match as WHOLE WORDS via
 *    word boundaries — "sb" blocks "he is sb" but NOT "alsbachite".
 *  - Terms that start/end with non-word chars ("/kick", "100%", "C++")
 *    fall back to case-insensitive substring matching, because \b
 *    cannot anchor on non-word characters.
 *  - Non-ASCII (CJK) terms match as case-insensitive substrings.
 */
export function matchTerms(text, terms) {
  if (!text || !terms.length) return null;
  const lower = text.toLowerCase();
  for (const term of terms) {
    const isAscii = /^[\x00-\x7F]+$/.test(term);
    const hit = isAscii && /^\w/.test(term) && /\w$/.test(term)
      ? new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text)
      : lower.includes(term.toLowerCase());
    if (hit) return term;
  }
  return null;
}

export const matchBlacklist = (text, terms) => matchTerms(text, terms);
export const matchWhitelist = (text, terms) => matchTerms(text, terms);

function mutateTerm(path, term, mode) {
  const clean = term.trim();
  if (!clean) return { ok: false, error: "empty term" };
  if (clean.startsWith("#")) {
    return { ok: false, error: `"${clean}" starts with # — that would be treated as a comment` };
  }
  const rawLines = fs.existsSync(path) ? fs.readFileSync(path, "utf8").split(/\r?\n/) : [];
  const lower = clean.toLowerCase();
  if (mode === "add") {
    if (rawLines.some((l) => l.trim().toLowerCase() === lower)) {
      return { ok: false, error: `"${clean}" is already in the list` };
    }
    // Ensure the previous line ends with a newline so the term gets
    // its own line.
    const needsNl = rawLines.length > 0 && rawLines[rawLines.length - 1] !== "";
    fs.appendFileSync(path, `${needsNl ? "\n" : ""}${clean}\n`);
    return { ok: true, term: clean };
  }
  // remove: keep comments and blank lines, drop the exact term line.
  const kept = rawLines.filter((l) => l.trim().toLowerCase() !== lower);
  if (kept.length === rawLines.length) {
    return { ok: false, error: `"${clean}" is not in the list` };
  }
  fs.writeFileSync(path, kept.join("\n"));
  return { ok: true, term: clean };
}

export const addBlacklistTerm = (term, path = config.blacklistPath) => mutateTerm(path, term, "add");
export const removeBlacklistTerm = (term, path = config.blacklistPath) => mutateTerm(path, term, "remove");
export const addWhitelistTerm = (term, path = config.whitelistPath) => mutateTerm(path, term, "add");
export const removeWhitelistTerm = (term, path = config.whitelistPath) => mutateTerm(path, term, "remove");

// ── User blacklist (拉黑用户) ───────────────────────────────────────
// banned_users.txt — one user id per line (u_<discordId>), `#` comment.
// A blacklisted member's messages are removed INSTANTLY on ingest,
// whatever the content.

export function loadBannedUsers(path = config.bannedUsersPath) {
  return loadTerms(path);
}

export function isUserBanned(userId, banned = loadBannedUsers()) {
  return banned.includes(userId);
}

export function addBannedUser(userId, path = config.bannedUsersPath) {
  const clean = userId.trim();
  if (!clean) return { ok: false, error: "empty user id" };
  const res = mutateTerm(path, clean, "add");
  return res;
}

export function removeBannedUser(userId, path = config.bannedUsersPath) {
  const clean = userId.trim();
  if (!clean) return { ok: false, error: "empty user id" };
  return mutateTerm(path, clean, "remove");
}
