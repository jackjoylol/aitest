# Hearthkeeper — Architecture

Hearthkeeper is a **thin product shell around a Minds agent**. The Mind
is the moderator: it learns the community's norms, rules on every post,
remembers members across sessions, learns from creator overrides and
writes the daily community-health digest. The app is only the queue,
the audit log, the scheduler and the dashboard.

```
                     ┌─────────────────────────────────────────────┐
                     │             Minds platform                  │
                     │  (Minds by Animoca Brands, api.build)       │
                     │                                             │
                     │   Mind  "Hearthkeeper Steward"              │
                     │   ├─ Brain   (model layer)                  │
                     │   ├─ Soul    (identity, MEMORY, continuity) │
                     │   ├─ Skills  (Bazaar, optional equips)      │
                     │   └─ Circle  (trust gate: creator + mods)   │
                     │                                             │
                     │   Conversation  alias="hearthkeeper-main"   │
                     │   (persistent, cross-session transcript)    │
                     └───────────────▲─────────────────────────────┘
                                     │ Builder API (X-Api-Key)
   platforms (Discord/Telegram/…)    │ @animocabrands/minds-client-lib
   ────────────────┐                 │
   POST /api/webhook▼                 │
   ┌──────────────────────────────────────────────┐
   │  Hearthkeeper (Node 22+, Express)             │
   │  ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
   │  │ queue    │ │ scheduler│ │ dashboard/UI  │  │
   │  │ + webhook│ │ (cron)   │ │ (vanilla SPA) │  │
   │  └────┬─────┘ └────┬─────┘ └──────┬────────┘  │
   │       │            │              │           │
   │  ┌────▼────────────▼──────────────▼────────┐  │
   │  │ SQLite audit log (users/posts/decisions │  │
   │  │ reports/meta) — creator-facing record   │  │
   │  └─────────────────────────────────────────┘  │
   └──────────────────────────────────────────────┘
```

## Persistence — three layers, one story

The submission requirement is *"memory, continuity, or autonomous
follow-up across sessions"*. Hearthkeeper demonstrates all three, at
three layers:

| Layer | What persists | Where | Evidence |
|---|---|---|---|
| **Soul memory** | Community norms, precedents, member history, corrections | Minds platform | Mind recalls past rulings & members in later sessions; learns from creator overrides |
| **Conversation** | Full transcript of every review/escalation/digest/chat | Minds platform (stable alias) | `GET /v1/messaging/histories/{alias}`; survives app restarts |
| **Audit log** | Every post, verdict, override, report | Local SQLite (`data/hearthkeeper.db`) | Dashboard decision log; works even offline |

The onboarding protocol makes Soul memory deterministic: the norms file
(`norms/community.md`) is hashed; whenever it changes, the app re-teaches
the Mind (`ensureOnboarded` → `POST /v1/messaging/message` + ack). The
Mind's own long-term memory then carries the rules across sessions.

## The message protocol

All Mind traffic goes through one stable conversation alias
(`HEARTHKEEPER_ALIAS`), so the Mind always has full context. The Mind is
instructed (see `docs/MIND_SETUP.md`) to reply with **one JSON object,
no markdown**, and `src/moderation.js` builds/parses the protocol:

| Flow | Prompt header | Reply schema |
|---|---|---|
| Onboarding | `COMMUNITY NORMS … --- BEGIN NORMS ---` | free-text ack |
| Review batch | `REVIEW BATCH batch=<id> … POSTS: [1] user=… channel=… text="…"` | `{batchId, verdicts:[{postId,action,severity,category,reason}]}` |
| Creator override | `OVERRIDE: you ruled "X" on post … changed it to "Y"` | free-text ack (fire-and-forget) |
| Escalation | `ESCALATION REVIEW … - u_bob (2 violations)` | `{members:[{userId,action,reason}]}` |
| Daily digest | `DAILY DIGEST … allowed: N, flagged: N, removed: N` | `{summary,healthScore,concerns,recommendations}` |

**Robustness:** the parser (`extractJson`) finds the first balanced JSON
value inside prose or markdown fences; verdicts are validated against
fixed enums (`allow|flag|remove`, severities, categories); a batch whose
reply cannot be parsed is **not** silently dropped — every post in it is
marked `flag` → *human review*, and the raw reply is returned to the UI.

**Efficiency:** posts are reviewed in batches (default 8) so N posts cost
≈1 cognition turn. Post text is escaped into the prompt with Unicode
kept intact (`escapePromptText`), so quotes, newlines, emoji and
non-Latin content survive; the verdict references posts by list index,
which LLMs echo far more reliably than UUIDs. The parser also
normalises `<br>` HTML newlines some Minds emit inside JSON replies.

## Autonomy

`src/scheduler.js` (node-cron) drives three unattended behaviours:

1. **Auto-review** — when pending posts reach `AUTO_REVIEW_MIN_PENDING`,
   the queue is sent to the Mind (guard: never overlaps a manual review).
2. **Daily digest** — the Mind writes the community health report from
   the last 24 h of the audit log.
3. **Escalation review** — repeat offenders (≥1 violation) are presented
   to the Mind, which rules `warn | restrict | ban` per member.

All schedules and thresholds are env-tunable (`.env.example`).

**Concurrency:** every Mind turn (send + wait) is serialised through a
single queue, so review / digest / escalation / chat / onboarding can
never steal each other's replies on the shared conversation alias.

## Instant dictionaries & the learning loop

Two term dictionaries make deterministic rulings instant:

- **`blacklist.txt`** — a message containing a blacklisted term is
  removed on ingest with reason `Blacklisted term: "…"`. No Mind call,
  zero cognition, zero waiting.
- **`whitelist.txt`** — a message containing a whitelisted term is
  allowed on ingest (`Whitelisted term: "…"`). Blacklist is checked
  first and wins (safety first).

**Matching:** pure-word ASCII terms match as whole words (word
boundaries — `sb` blocks "he is sb" but not "alsbachite"); terms with
non-word edges (`/kick`, `100%`) fall back to case-insensitive
substring matching; CJK terms match as substrings. Both files are
re-read on every check, so edits take effect immediately; the Discord
`!blacklist` / `!whitelist` commands manage them from chat.

**The Mind learns both dictionaries.** The review protocol's verdicts
carry an optional `keywords` array — the words the Mind names as the
driver of its ruling. The app files them into the blacklist
(`remove` rulings) or whitelist (`allow` rulings) automatically, so the
next identical message is handled instantly with zero cognition.
Guardrails: keywords are validated (≥2 chars, ≤40, max 5 per verdict),
deduplicated case-insensitively, and file-write failures are logged
without aborting the review.

## Mind → app loop (creator correction)

When a creator overrides a verdict, the app:
1. writes the override to the audit log (`source=creator-override`),
2. recomputes violation counts from the posts' **current** rulings
   (an override to `allow` clears the member's violation for that post),
3. sends the Mind an `OVERRIDE` correction message — the Mind's Soul
   absorbs it and applies it to future rulings.

This is the "learns from you" loop: norms file for the stable law,
corrections for the case law.

## Security & privacy

- The Builder API key lives only in `.env` (`MINDS_BUILDER_API_KEY`),
  never in the UI; the server is the only caller of the Minds client.
- `POST /api/webhook` is protected by an optional bearer token
  (`WEBHOOK_TOKEN`); the dashboard is meant for local/trusted use.
- All user-generated text is HTML-escaped in the UI (XSS-safe).
- The platform's **Circle trust gate** means the Mind only ever hears
  the creator, the app and explicitly invited mods — strangers are
  silently blocked (prompt-injection-resistant by design).
- No PII is required; member IDs are app-chosen handles.

## Code map

| Path | Responsibility |
|---|---|
| `src/config.js` | env → config (all defaults) |
| `src/minds.js` | Minds client wrapper + offline mock (same interface) |
| `src/moderation.js` | prompt builders + reply parsers (pure, unit-tested) |
| `src/db.js` | SQLite schema + queries |
| `src/server.js` | Express API, webhook, onboarding, wiring |
| `src/discord.js` | Discord bot: message intake → review → verdict back in chat |
| `src/scheduler.js` | cron jobs (auto-review / digest / escalation) |
| `ui/` | vanilla-JS dashboard (no build step) |
| `scripts/` | `setup` / `seed` / `demo` |
| `test/` | `node --test` protocol + mock behaviour tests |
| `norms/community.md` | the community constitution taught to the Mind |
