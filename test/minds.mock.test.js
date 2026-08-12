// test/minds.mock.test.js — behaviour tests for the offline mock Mind,
// which simulates the real platform's Soul (memory + continuity).
// Run with:  npm test   (node --test)

import { test, before } from "node:test";
import assert from "node:assert/strict";

import config from "../src/config.js";
import { getMinds, resetMinds } from "../src/minds.js";
import { buildReviewPrompt, parseReviewReply } from "../src/moderation.js";

const NORMS = "Be kind. No spam. No hate speech.";

before(async () => {
  // Force mock mode (config is a live object; getMinds() reads it lazily).
  config.mock = true;
  config.alias = "test-alias";
  resetMinds();
  globalThis.__minds = await getMinds();
});

const review = async (posts) => {
  const minds = globalThis.__minds;
  const prompt = buildReviewPrompt({ batchId: "hb-test", communityName: "Pine", posts, normsText: NORMS });
  await minds.sendMessage({ alias: config.alias, messageText: prompt });
  const outcome = await minds.waitForReply({ alias: config.alias, sentMessageText: prompt });
  const parsed = parseReviewReply(outcome.reply.messageText);
  assert.ok(!parsed.error, `mock reply should parse: ${outcome.reply.messageText}`);
  return parsed.verdicts;
};

test("mock: spam is removed, healthy posts are allowed", async () => {
  const verdicts = await review([
    { id: "a1", user_id: "u_spam", channel: "general", text: "FREE CRYPTO AIRDROP!!! CLAIM YOUR 100x NOW!!!" },
    { id: "a2", user_id: "u_art", channel: "critique", text: "wip! trying painterly lighting, critique welcome" },
  ]);
  const byId = Object.fromEntries(verdicts.map((v) => [v.postId, v]));
  assert.equal(byId["1"].action, "remove");
  assert.equal(byId["1"].category, "spam");
  assert.equal(byId["2"].action, "allow");
});

test("mock: repeat offenders escalate across batches (Soul continuity)", async () => {
  // First offense: mild insult → flag.
  const first = await review([
    { id: "b1", user_id: "u_troll", channel: "general", text: "your art is trash, uninstall" },
  ]);
  assert.equal(first[0].action, "flag");

  // Second offense, same member, next batch → escalated to remove.
  const second = await review([
    { id: "b2", user_id: "u_troll", channel: "general", text: "still trash, give up" },
  ]);
  assert.equal(second[0].action, "remove");
  assert.match(second[0].reason, /Repeat offender/);
});

test("mock: history persists across calls and fingerprints advance", async () => {
  const minds = globalThis.__minds;
  const before = await minds.getLatestHistoryFingerprint(config.alias);
  await minds.sendMessage({ alias: config.alias, messageText: "hello?" });
  const after = await minds.getLatestHistoryFingerprint(config.alias);
  assert.notEqual(before, after);
  const rows = await minds.getHistory(config.alias, { limit: 10 });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => typeof r.messageText === "string" && r.senderType !== undefined));
});
