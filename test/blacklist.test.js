// test/blacklist.test.js — unit tests for the instant blacklist.
// Run with:  npm test   (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadBlacklist, matchBlacklist, addBlacklistTerm, removeBlacklistTerm,
  loadWhitelist, matchWhitelist, addWhitelistTerm, removeWhitelistTerm,
} from "../src/blacklist.js";

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `hk-bl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, content);
  return p;
}

test("loadBlacklist: reads terms, skips comments and blank lines", () => {
  const p = tmpFile("# comment\nfuck you\n\n傻逼\n# another comment\nsb  \n");
  assert.deepEqual(loadBlacklist(p), ["fuck you", "傻逼", "sb"]);
  fs.unlinkSync(p);
});

test("loadBlacklist: missing file → empty list", () => {
  assert.deepEqual(loadBlacklist(path.join(os.tmpdir(), "definitely-missing.txt")), []);
});

test("matchBlacklist: case-insensitive substring, first hit wins", () => {
  assert.equal(matchBlacklist("FUCK YOU dude", ["fuck you", "sb"]), "fuck you");
  assert.equal(matchBlacklist("你好傻逼啊", ["傻逼"]), "傻逼");
  assert.equal(matchBlacklist("i said sb to him", ["sb", "fuck you"]), "sb");
  assert.equal(matchBlacklist("hello world", ["sb"]), null);
  assert.equal(matchBlacklist("", ["sb"]), null);
  assert.equal(matchBlacklist("hi", []), null);
});

test("matchBlacklist: ASCII terms match whole words only (no false positives)", () => {
  // "sb" must NOT match words that merely CONTAIN it…
  assert.equal(matchBlacklist("alsbachite is a mineral", ["sb"]), null);
  assert.equal(matchBlacklist("absorb the liquid", ["sb"]), null);
  assert.equal(matchBlacklist("asbestos", ["sb"]), null);
  // …but must match the standalone word, including with punctuation,
  // mixed case, or surrounded by CJK text.
  assert.equal(matchBlacklist("he is sb", ["sb"]), "sb");
  assert.equal(matchBlacklist("SB!!!", ["sb"]), "sb");
  assert.equal(matchBlacklist("他说sb啊", ["sb"]), "sb");
  // Chinese terms keep substring matching.
  assert.equal(matchBlacklist("垃圾处理厂不是骂人", ["垃圾"]), "垃圾");
});

test("addBlacklistTerm: appends and dedupes case-insensitively", () => {
  const p = tmpFile("sb\n");
  assert.deepEqual(addBlacklistTerm("new term", p), { ok: true, term: "new term" });
  assert.ok(loadBlacklist(p).includes("new term"));
  const dup = addBlacklistTerm("SB", p); // case-insensitive dedupe
  assert.equal(dup.ok, false);
  assert.equal(addBlacklistTerm("   ", p).ok, false); // empty
  fs.unlinkSync(p);
});

test("removeBlacklistTerm: removes exact term, keeps the rest", () => {
  const p = tmpFile("sb\n傻逼\n");
  const r = removeBlacklistTerm("SB", p);
  assert.equal(r.ok, true);
  assert.deepEqual(loadBlacklist(p), ["傻逼"]);
  const miss = removeBlacklistTerm("nope", p);
  assert.equal(miss.ok, false);
  fs.unlinkSync(p);
});

test("whitelist: load / match / add / remove", () => {
  const p = tmpFile("# safe\nwip\ncritique welcome\n");
  assert.deepEqual(loadWhitelist(p), ["wip", "critique welcome"]);
  assert.equal(matchWhitelist("WIP! trying painterly lighting", ["wip"]), "wip");
  assert.equal(matchWhitelist("spam spam", ["wip"]), null);
  const added = addWhitelistTerm("art share", p);
  assert.equal(added.ok, true);
  assert.ok(loadWhitelist(p).includes("art share"));
  const removed = removeWhitelistTerm("wip", p);
  assert.equal(removed.ok, true);
  assert.ok(!loadWhitelist(p).includes("wip"));
  fs.unlinkSync(p);
});

test("matchBlacklist: special-char terms (/kick, 100%) fall back to substring", () => {
  // /kick starts with a non-word char → \b can't anchor → substring match
  assert.equal(matchBlacklist("/kick", ["/kick"]), "/kick");
  assert.equal(matchBlacklist("use /kick on him", ["/kick"]), "/kick");
  assert.equal(matchBlacklist("get 100% off today", ["100%"]), "100%");
  // "c++" ends with a non-word char → substring fallback (a known
  // trade-off: it can also match "ac++b", but such terms are rare).
  assert.equal(matchBlacklist("c++ is great", ["c++"]), "c++");
  assert.equal(matchBlacklist("i love C++", ["c++"]), "c++");
  // pure-word terms still respect word boundaries
  assert.equal(matchBlacklist("sbs are weird", ["sb"]), null);
});

test("removeBlacklistTerm keeps comments and blank lines", () => {
  const p = tmpFile("# header comment\n\nsb\n傻逼\n# footer\n");
  const r = removeBlacklistTerm("SB", p);
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(p, "utf8");
  assert.ok(raw.includes("# header comment"));
  assert.ok(raw.includes("# footer"));
  assert.ok(!raw.includes("\nsb\n"));
  assert.deepEqual(loadBlacklist(p), ["傻逼"]);
  fs.unlinkSync(p);
});

test("addBlacklistTerm handles files without trailing newline", () => {
  const p = tmpFile("sb"); // no trailing \n
  const r = addBlacklistTerm("fuck you", p);
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(p, "utf8");
  assert.ok(raw.endsWith("fuck you\n"));
  assert.deepEqual(loadBlacklist(p), ["sb", "fuck you"]);
  fs.unlinkSync(p);
});

test("addBlacklistTerm rejects comment-looking terms", () => {
  const p = tmpFile("sb\n");
  const r = addBlacklistTerm("#foo", p);
  assert.equal(r.ok, false);
  fs.unlinkSync(p);
});

test("blacklist wins over whitelist (safety first)", () => {
  const text = "nice wip but you are sb";
  const bad = matchBlacklist(text, ["sb"]);
  const good = matchWhitelist(text, ["wip"]);
  assert.equal(bad, "sb");
  assert.equal(good, "wip");
  // The ingest pipeline checks blacklist FIRST and short-circuits, so
  // the post is removed even though it also contains a whitelisted term.
  assert.ok(bad && good);
});
