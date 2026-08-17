// linkguard.js — 廣告/邀請連結專用攔截模組
//
// Separate pipeline that catches the two most common community
// nuisances BEFORE the Mind sees anything:
//   1. Discord invite links (discord.gg/xxx, discord.com/invite, etc.)
//   2. External promotional links (any http(s) URL whose host is not
//      an allow-listed domain)
//
// Checks, in order: newbie gate (new member cooldown) → discord invite
// → external link (allow-list). All checks are pure functions so they
// are unit-testable offline.
//
// Allowed-domain matching handles subdomains: allow "example.com" → a
// link to "cdn.example.com" is allowed too. Whitelisted domains are
// read live from the allow-list file, so edits apply immediately.

import fs from "node:fs";
import config from "./config.js";

const DISCORD_INVITE_RE =
  /(?:discord\.(?:gg|com\/invite|app\/invite|io|me)\/[\w-]+|discordapp\.com\/invite\/[\w-]+)/i;

/** Extract the hostname of the first URL in a text, or null. */
export function extractHost(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/https?:\/\/([^\/\s]+\/?)/i);
  if (!m) return null;
  let host = m[1].replace(/\/$/, "").toLowerCase();
  // Strip port, if any.
  host = host.replace(/:\d+$/, "");
  return host;
}

/** True if the text contains a Discord invite link. */
export function hasDiscordInvite(text) {
  if (!text || typeof text !== "string") return false;
  return DISCORD_INVITE_RE.test(text);
}

/** True if hostname is an allow-listed domain or a subdomain of one. */
export function isAllowedHost(host, allowedDomains) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const d of allowedDomains) {
    const base = d.toLowerCase().replace(/^\./, "").replace(/\/$/, "");
    if (!base) continue;
    if (h === base || h.endsWith(`.${base}`)) return true;
  }
  return false;
}

/** Find the external (non-allow-listed) link host in text, or null. */
export function findExternalLink(text, allowedDomains) {
  if (!text || typeof text !== "string") return null;
  for (const m of text.matchAll(/https?:\/\/([^\/\s]+\/?)/gi)) {
    const raw = m[1].replace(/\/$/, "");
    const host = raw.replace(/:\d+$/, "").toLowerCase();
    if (!isAllowedHost(host, allowedDomains)) return host;
  }
  return null;
}

/** Load allow-listed domains from a file (one per line, `#` comment). */
export function loadAllowedDomains(path = config.allowedDomainsPath) {
  if (!fs.existsSync(path)) return [];
  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
}
