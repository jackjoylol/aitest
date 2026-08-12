# 🛡️ Hearthkeeper

**An always-on community steward powered by a Minds agent.**

Intelligent moderation that understands context and community norms —
for the creator economy. The Mind learns *your* community's rules,
remembers every member across sessions, and follows up on its own:
queue auto-reviews, daily health digests, repeat-offender escalations,
and a creator correction loop that teaches it your judgment.

Built for the **Creative Minds Jam #1: Hong Kong — Moderation &
community assistance** track, on **Minds by Animoca Brands**.

---

## Why it exists (creator-economy problem fit)

Community creators (Discord/Telegram/YouTube/forum owners) face a
triple bind:

- **Keyword filters are dumb** — they can't read context ("trash" in a
  critique thread vs. an attack), and they drown honest members in false
  positives.
- **Human moderators are expensive** — a creator with 5k members can't
  pay a 24/7 team.
- **Norms are local** — every community has its own constitution; a
  generic model doesn't know yours.

Hearthkeeper's bet: **your norms, learned once, enforced always** — by a
Minds agent whose Soul remembers, whose conversation persists, and whose
scheduler acts without being asked.

## What it does

| Capability | How |
|---|---|
| **Learns your norms** | `norms/community.md` is taught to the Mind at onboarding (sha256-change detection re-teaches automatically) |
| **Rules on every post** | Batched review → structured verdicts (`allow / flag / remove` + severity + category + reason) |
| **Remembers members** | Repeat offenders escalate across sessions — 2nd offense is harsher than the 1st |
| **Learns from you** | One-click creator overrides → `OVERRIDE` correction back to the Mind's Soul |
| **Acts autonomously** | Cron scheduler: auto-reviews the queue, writes the daily digest, runs escalation reviews |
| **Instant black/whitelist** | `blacklist.txt` / `whitelist.txt` term dictionaries — instant remove/allow on ingest, zero cognition; the **Mind files keywords into both automatically** when it rules; manage from Discord via `!blacklist` / `!whitelist` |
| **Lives where you live** | Webhook intake (`POST /api/webhook`) + **Discord bot** (`npm run discord`, verdicts posted back in chat) + the Mind itself can join your Telegram group as a bot; your mod team joins its **Circle** |

## Quickstart (2 minutes, zero credentials)

```bash
cd hearthkeeper
cp .env.example .env        # HEARTHKEEPER_MOCK=1 for offline demo
npm install
npm run reset               # clean slate — every record is REAL activity
npm start                   # → http://localhost:4173
```

Click **Review queue →** and watch the (mock) Mind rule on all 14 posts.
`npm test` runs 36 unit tests (protocol parsing, mock behaviour, term
dictionaries).

## Connect your real Mind (10 minutes)

1. Create a Mind at **hellominds.ai/profile** and paste the instructions
   from [`docs/MIND_SETUP.md`](docs/MIND_SETUP.md) into it.
2. Create a **Builder API key** → put it in `.env` as
   `MINDS_BUILDER_API_KEY`; set `HEARTHKEEPER_MOCK=0`.
3. `npm run setup` → `npm start`. The dashboard chip turns 🟢 with your
   Mind's name and cognition balance.

## Demo script

[`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — the 90-second video script:
problem → the Mind as core → persistence (restart the server, chat asks
the Mind about yesterday) → autonomy (digest + escalation) → correction
loop.

## Repository layout

```
hearthkeeper/
├── src/            server: minds client, moderation protocol, db,
│                   scheduler, api, discord bot, blacklist/whitelist
├── ui/             vanilla-JS dashboard (no build step)
├── scripts/        setup / reset / demo
├── test/           node --test unit tests (protocol, mock, dictionaries)
├── norms/          your community's constitution (taught to the Mind)
├── blacklist.txt   instant auto-delete dictionary (Mind learns it too)
├── whitelist.txt   instant auto-allow safe-word dictionary
└── docs/           ARCHITECTURE · MIND_SETUP · DISCORD · DEMO_SCRIPT
```

## Judging-criteria map

| Criterion | Where it lives |
|---|---|
| **Minds Integration Depth** | The Mind decides *everything*: every verdict, escalation and digest comes from it (single conversation alias, Soul memory, cognition tracked live in the UI) |
| **Creator-Economy Problem Fit** | Norms are per-community (`norms/community.md`), cost is ~1 cognition turn per 8 posts, works solo or with a mod team via Circles/Telegram |
| **Innovation & Creativity** | Creator-override correction loop; index-based batch protocol (reliable JSON at low cost); three-layer persistence story |
| **Execution & Completeness** | Runnable in mock mode with zero credentials; real-data testing via `npm run reset`; dashboard; Discord bot; webhook; scheduler; 36 unit tests; full docs |
| **Viability & Scalability** | Webhook intake = any platform; Mind scales on the platform; audit log makes the product auditable for platform TOS compliance |

## Tech

Node 22+ · Express · better-sqlite3 · node-cron ·
[`@animocabrands/minds-client-lib`](https://build.hellominds.ai/en/docs/get-started/client-library)
(Builder API, `X-Api-Key`).

**Offline mock mode** (`HEARTHKEEPER_MOCK=1`) simulates the Mind with
deterministic heuristics + in-process memory, so the whole product is
demoable before a Minds account exists. Every mock screen is labelled
`🧪 MOCK` — the real integration is the default path.

## License

MIT
