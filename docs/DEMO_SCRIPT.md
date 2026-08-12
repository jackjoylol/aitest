# Hearthkeeper — demo video script (1:30–2:00)

> Goal: show a **working product** whose core is a **Minds agent**, with
> **memory, continuity and autonomous follow-up** — for creator-economy
> moderation. Record screen + voiceover. Keep cuts tight; every shot
> below has a purpose the judges can tick off.

---

## 0:00–0:20 — Hook + problem (title card / talking head)

> *"Every community creator spends hours a day breaking up fights,
> deleting spam and rewriting the same rules. Keyword filters are dumb,
> human moderators are expensive. Meet **Hearthkeeper** — an always-on
> community steward powered by a Minds agent. It learns YOUR community's
> norms, remembers every member across sessions, and follows up on its
> own."*

**On screen:** logo + the three pillars: *Learns · Remembers · Acts*.

## 0:20–0:40 — The Mind is the core

> *"The moderator isn't a rules engine — it's a real Minds agent. The
> community's norms live in its Soul, the model layer is its Brain, and
> it's always-on on the Minds platform."*

**On screen:**
1. hellominds.ai/profile — the Mind "Hearthkeeper Steward", its Brain
   model, its **Circle** (creator + mods).
2. `npm run setup` in the terminal → `minds list`, conversation alias
   bound, cognition balance.

## 0:40–1:05 — Persistence: it remembers

> *"Two days of community traffic come in. We hit Review — every post is
> ruled by the Mind, with a reason. The same spammer posts again the next
> day — and the Mind remembers him. First offense: removed. Second
> offense: recognized from memory, escalated, and the escalation review
> restricts him automatically. That's the Soul: continuity across
> sessions, not a fresh LLM every time."*

**On screen:**
1. Dashboard queue → **Review queue** → verdicts appear (allow/flag/remove
   + reasons). (Real Mind replies; ~30–90 s.)
2. Members tab: Bob 2 violations.
3. **Mind chat** tab: scroll the persistent transcript — the conversation
   survived restarts; ask *"Who did we remove yesterday and why?"* and the
   Mind answers from memory.
4. (Optional, strongest) restart the server (`Ctrl+C`, `npm start`),
   reopen — queue/decisions/chat all still there.

## 1:05–1:25 — Autonomy + creator loop

> *"Hearthkeeper doesn't wait to be asked. The scheduler reviews the
> queue on its own, and every morning the Mind writes a community health
> digest with a score and recommendations. When the creator disagrees
> with a ruling, one click overrides it — and the correction is taught
> back to the Mind, so next time it rules right."*

**On screen:**
1. Reports tab: digest card (score 82/100, concerns, recommendations).
2. Decisions tab: an **Override** (e.g. remove → flag, with note).
3. Mind chat: the correction message visible in the transcript.

## 1:25–1:50 — Where it lives + wrap-up

> *"Hearthkeeper is a thin shell — the Mind does the thinking, the app
> keeps the audit log. Inbound posts come from any platform via one
> webhook, and the same Mind can join your Telegram group as a bot —
> your whole mod team in its Circle. Spam down, sleep restored, one
> community at a time."*

**On screen:** `POST /api/webhook` example + Telegram bot mention (static
shot of circles guide), then closing card: *Hearthkeeper — powered by
Minds by Animoca Brands.*

---

## Pre-flight checklist

- [ ] Real Mind created + `MINDS_BUILDER_API_KEY` in `.env`
- [ ] `npm run setup` passes (alias bound)
- [ ] `npm run seed` loaded the demo community
- [ ] `npm start` → dashboard loads, chip shows 🟢 Mind name
- [ ] Review queue works (allow spare time — real replies take time)
- [ ] Restart the server once to film the persistence shot
- [ ] Webhook: `curl -X POST localhost:4173/api/webhook -H "Content-Type: application/json" -d '{"userId":"u_demo","userName":"Demo","text":"hello world"}'`

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chip shows 🔴 Mind offline | Check API key, run `npm run setup` |
| Review takes > 90 s | Normal for batch reviews; wait for the alert |
| No cognition left | Top up at hellominds.ai/profile |
| Unparseable reply | Batch goes to human review (flag) — show this as a feature in the video if it happens |
