// test/moderation.test.js — unit tests for the message protocol.
// Run with:  npm test   (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOnboardingPrompt, buildReviewPrompt, buildOverrideMessage,
  buildEscalationPrompt, buildDigestPrompt,
  parseReviewReply, parseEscalationReply, parseDigestReply,
  extractJson, validateVerdict, digestCounts, batchId, escapePromptText,
} from "../src/moderation.js";

const NORMS = "Be kind. No spam. No hate speech.";
const POSTS = [
  { id: "p1", user_id: "u_alice", channel: "general", text: 'wip! "painterly" lighting \\ test' },
  { id: "p2", user_id: "u_bob", channel: "general", text: "check out my NFT, dm me" },
];

test("buildReviewPrompt emits the [n] protocol and escapes post text", () => {
  const prompt = buildReviewPrompt({ batchId: "hb-test-1", communityName: "Pine", posts: POSTS, normsText: NORMS });
  assert.ok(prompt.includes("REVIEW BATCH batch=hb-test-1"));
  assert.ok(prompt.includes("[1] user=u_alice channel=general"));
  assert.ok(prompt.includes('text="wip! \\"painterly\\" lighting \\\\ test"'));
  assert.ok(prompt.includes("[2] user=u_bob"));
  assert.ok(prompt.includes(NORMS));
});

test("buildOnboardingPrompt includes norms and end markers", () => {
  const p = buildOnboardingPrompt({ communityName: "Pine", normsText: NORMS });
  assert.ok(p.includes("COMMUNITY NORMS"));
  assert.ok(p.includes("--- BEGIN NORMS ---"));
  assert.ok(p.includes("--- END NORMS ---"));
});

test("buildOverrideMessage carries from/to and note", () => {
  const msg = buildOverrideMessage({ post: { id: "p2", text: "nft spam" }, fromAction: "remove", toAction: "flag", note: "it was a joke" });
  assert.ok(msg.includes('"remove"'));
  assert.ok(msg.includes('"flag"'));
  assert.ok(msg.includes("Creator note: \"it was a joke\""));
});

test("buildEscalationPrompt lists members with violation counts", () => {
  const p = buildEscalationPrompt({
    batchId: "hb-x", communityName: "Pine",
    members: [{ user_id: "u_bob", violations: 2, last_category: "spam" }],
    normsText: NORMS,
  });
  assert.ok(p.includes("- u_bob (2 violations)"));
});

test("buildDigestPrompt carries the counts line the parser/mock depend on", () => {
  const p = buildDigestPrompt({
    communityName: "Pine", windowLabel: "last 24 hours",
    counts: { allowed: 5, flagged: 2, removed: 3, pending: 1 },
    repeatOffenders: [{ user_id: "u_bob", violations: 2 }],
  });
  assert.ok(p.includes("allowed: 5, flagged: 2, removed: 3"));
  assert.ok(p.includes("u_bob (2 violations)"));
});

test("parseReviewReply: clean JSON", () => {
  const reply = JSON.stringify({
    batchId: "hb-test-1",
    verdicts: [
      { postId: "1", action: "allow", severity: "none", category: "none", reason: "fine" },
      { postId: "2", action: "remove", severity: "high", category: "spam", reason: "spam" },
    ],
  });
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.batchId, "hb-test-1");
  assert.equal(parsed.verdicts.length, 2);
  assert.equal(parsed.verdicts[1].action, "remove");
});

test("extractJson protects <br> inside string values", () => {
  const reply = '{"batchId":"b","verdicts":[{"postId":"1","action":"flag","reason":"line1<br>line2"}]}';
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.verdicts[0].reason, "line1<br>line2"); // untouched
});

test("extractJson: HTML <br> newlines (real Minds behaviour)", () => {
  const reply = '{<br>  "batchId": "hb-x",<br>  "verdicts": [<br>    {<br>      "postId": "1",<br>      "action": "flag",<br>      "severity": "low",<br>      "category": "other",<br>      "reason": "ok"<br>    }<br>  ]<br>}';
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.verdicts[0].action, "flag");
});

test("escapePromptText keeps Unicode, escapes protocol-breaking chars", () => {
  const out = escapePromptText('加我领免费币 "私信" 我 \\ 换行\n制表\t');
  assert.ok(out.includes("加我领免费币"));
  assert.ok(!out.includes("\\u")); // no \uXXXX escaping
  assert.ok(out.includes('\\"'));
  assert.ok(out.includes("\\\\"));
  assert.ok(out.includes("\\n"));
  assert.ok(out.includes("\\t"));
});

test("buildReviewPrompt keeps non-Latin text readable", () => {
  const prompt = buildReviewPrompt({
    batchId: "hb-test-2", communityName: "Pine",
    posts: [{ id: "p9", user_id: "u_zh", channel: "general", text: "加我领免费加密币" }],
    normsText: NORMS,
  });
  assert.ok(prompt.includes("加我领免费加密币"));
  assert.ok(!prompt.includes("\\u52a0")); // not JSON.stringify-escaped
});

test("parseReviewReply: markdown-fenced JSON", () => {
  const reply = "```json\n{\"batchId\":\"b\",\"verdicts\":[{\"postId\":\"1\",\"action\":\"flag\"}]}\n```";
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.verdicts[0].action, "flag");
  // defaults applied
  assert.equal(parsed.verdicts[0].severity, "none");
  assert.equal(parsed.verdicts[0].category, "other");
});

test("parseReviewReply: JSON buried in prose", () => {
  const reply = "Here you go!\n{\"verdicts\":[{\"postId\":\"2\",\"action\":\"remove\",\"category\":\"spam\"}]}\nHope that helps.";
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.verdicts[0].postId, "2");
});

test("parseReviewReply: numeric postId coerced, invalid entries dropped", () => {
  const reply = JSON.stringify({
    verdicts: [
      { postId: 3, action: "allow" },
      { postId: "4", action: "explode" },   // invalid action → dropped
      { action: "remove" },                  // missing postId → dropped
    ],
  });
  const parsed = parseReviewReply(reply);
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.verdicts[0].postId, "3");
});

test("parseReviewReply: no JSON at all → error", () => {
  const parsed = parseReviewReply("I cannot comply.");
  assert.ok(parsed.error);
});

test("validateVerdict normalises fields", () => {
  const v = validateVerdict({ postId: "1", action: "flag", severity: "EXTREME", category: "bogus", reason: "x" });
  assert.equal(v.severity, "none");   // unknown severity → default
  assert.equal(v.category, "other");  // unknown category → default
  assert.equal(v.action, "flag");
  assert.equal(validateVerdict({ postId: "1", action: "nope" }), null);
});

test("validateVerdict: keywords are filtered and capped", () => {
  const v = validateVerdict({
    postId: "1", action: "remove",
    keywords: ["free crypto", "  ", "x".repeat(99), "a", "i", "ok", "bc", "cd", "de"],
  });
  // blanks, >40 chars, and single chars dropped
  assert.deepEqual(v.keywords, ["free crypto", "ok", "bc", "cd", "de"]);
  const none = validateVerdict({ postId: "1", action: "allow" });
  assert.deepEqual(none.keywords, []);
});

test("extractJson handles nested braces and strings with braces", () => {
  const text = 'prefix {"a":{"b":"} still inside"},"c":[1,2]} suffix';
  assert.equal(extractJson(text), '{"a":{"b":"} still inside"},"c":[1,2]}');
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
});

test("parseEscalationReply validates member actions", () => {
  const ok = parseEscalationReply('{"members":[{"userId":"u_bob","action":"restrict","reason":"repeat"}]}');
  assert.equal(ok.members[0].action, "restrict");
  const bad = parseEscalationReply('{"members":[{"userId":"u_bob","action":"dance"}]}');
  assert.equal(bad.members.length, 0);
});

test("parseDigestReply clamps healthScore", () => {
  const d = parseDigestReply('{"summary":"ok","healthScore":250,"concerns":["x"],"recommendations":[]}');
  assert.equal(d.healthScore, 100);
  const d2 = parseDigestReply('{"summary":"ok","healthScore":-5}');
  assert.equal(d2.healthScore, 0);
});

test("digestCounts tallies from the audit log", () => {
  const decisions = [
    { action: "allow" }, { action: "allow" }, { action: "flag" }, { action: "remove" }, { action: "remove" },
  ];
  const c = digestCounts(decisions);
  assert.deepEqual({ allowed: c.allowed, flagged: c.flagged, removed: c.removed }, { allowed: 2, flagged: 1, removed: 2 });
});

test("batchId is unique and URL-safe", () => {
  const a = batchId();
  const b = batchId();
  assert.notEqual(a, b);
  assert.match(a, /^hb-[a-z0-9-]+$/);
});
