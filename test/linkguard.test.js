// test/linkguard.test.js — unit tests for the link guard module.
// Run with:  npm test   (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractHost, hasDiscordInvite, isAllowedHost, findExternalLink, loadAllowedDomains,
} from "../src/linkguard.js";

test("extractHost: pulls the hostname from a URL", () => {
  assert.equal(extractHost("check https://evil.store/buy now"), "evil.store");
  assert.equal(extractHost("https://cdn.example.com/x"), "cdn.example.com");
  assert.equal(extractHost("https://example.com:8080/p"), "example.com");
  assert.equal(extractHost("no url here"), null);
});

test("hasDiscordInvite: detects invite links", () => {
  assert.equal(hasDiscordInvite("join our server https://discord.gg/abc123"), true);
  assert.equal(hasDiscordInvite("discord.com/invite/xyz"), true);
  assert.equal(hasDiscordInvite("discordapp.com/invite/qwe"), true);
  assert.equal(hasDiscordInvite("discord.io/free"), true);
  assert.equal(hasDiscordInvite("discuss discord nothing here"), false);
  assert.equal(hasDiscordInvite(""), false);
});

test("isAllowedHost: allow-list with subdomains", () => {
  const allowed = ["example.com", "art.io"];
  assert.equal(isAllowedHost("example.com", allowed), true);
  assert.equal(isAllowedHost("cdn.example.com", allowed), true);  // subdomain
  assert.equal(isAllowedHost("example.com.evil.net", allowed), false); // not a sub, suffix trick
  assert.equal(isAllowedHost("evil.net", allowed), false);
  assert.equal(isAllowedHost("art.io", allowed), true);
  assert.equal(isAllowedHost("", allowed), false);
});

test("findExternalLink: first non-allow-listed host, skipping allowed ones", () => {
  const allowed = ["example.com"];
  assert.equal(findExternalLink("see https://ok.example.com/a then https://evil.store/b", allowed), "evil.store");
  // only allowed links → null
  assert.equal(findExternalLink("all fine https://example.com/a https://cdn.example.com/b", allowed), null);
  assert.equal(findExternalLink("no links", allowed), null);
});

test("loadAllowedDomains: reads file, skips comments/blanks, lowercases", () => {
  const p = path.join(os.tmpdir(), `hk-allow-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, "# comment\nExample.com\n  art.io  \n\n# another\n");
  const d = loadAllowedDomains(p);
  assert.deepEqual(d, ["example.com", "art.io"]);
  fs.unlinkSync(p);
  assert.deepEqual(loadAllowedDomains(path.join(os.tmpdir(), "definitely-missing.txt")), []);
});
