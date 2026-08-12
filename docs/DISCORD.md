# Connecting Discord (no dashboard needed)

Hearthkeeper runs a **Discord bot** that puts the Minds-powered
moderation right in your channels: every message is reviewed by the
Mind, and the verdict is posted back in chat — with optional
auto-delete for rule violations. The dashboard only needs to be running
in the background; you never have to open it.

```
 Discord channel                Hearthkeeper engine (localhost)      Minds platform
┌──────────────┐   message   ┌──────────────────────────────┐   ┌──────────────────┐
│ member posts │ ──────────► │ /api/webhook  → queue        │   │  jackjoyool      │
│              │             │ /api/review  → batch prompt ─┼──►│  (the Mind)      │
│  verdict     │ ◄────────── │ verdicts → audit log         │   │  Soul + memory   │
│  posted back │  (bot)      └──────────────────────────────┘   └──────────────────┘
└──────────────┘
```

## 1. Create the bot (5 minutes, in your browser)

1. Open **https://discord.com/developers/applications** → **New
   Application** → name it `Hearthkeeper` → Create.
2. Left menu → **Bot** → **Reset Token** → **Copy** (shown once).
3. (Optional but recommended) under **Bot → Privileged Gateway
   Intents**, enable **MESSAGE CONTENT INTENT** — required for the bot
   to read message text.
4. Left menu → **OAuth2 → URL Generator**:
   - Scopes: **bot**
   - Bot permissions: **View Channels** + **Send Messages** +
     **Manage Messages** (Manage Messages is what lets the bot
     auto-delete "remove" rulings)
   - Copy the generated URL, open it in a browser, pick your server,
     Authorize.

## 2. Configure `.env`

```bash
DISCORD_TOKEN=your_bot_token_here
DISCORD_CHANNEL_IDS=            # empty = all channels
DISCORD_DELETE_REMOVED=1        # 1 = auto-delete "remove" messages
```

To moderate only specific channels: enable **Developer Mode** in
Discord (Settings → Advanced), right-click the channel → **Copy Channel
ID**, and list them comma-separated, e.g.
`DISCORD_CHANNEL_IDS=123456789012345678,987654321098765432`.

**To route ALL bot/Mind output to one channel** (e.g. `#bot-output`):
create the channel, copy its ID, and set
`DISCORD_OUTPUT_CHANNEL_ID=<channel id>`. Every verdict, command reply,
blacklist notice and digest then lands there instead of the channel the
message came from — the source channel stays clean for members. Optionally
lock the output channel in Discord's channel permissions so only the bot
can post in it (see below).

**Making the output channel bot-only** (Discord side): open the channel →
Edit Channel → Permissions → for `@everyone` disable **Send Messages**
(keep View Channel) → add the bot with **Send Messages** allowed. Members
can read the moderation log but not write to it.

## 3. Run

Two terminals:

```bash
npm start          # terminal 1 — the Hearthkeeper engine (must be running)
npm run discord    # terminal 2 — the bot
```

You should see `Discord bot online as Hearthkeeper#1234`.

## 4. Try it

- Post anything in a watched channel → within ~30–90 s the bot replies:
  `✅ 审核完成 · <you> 判决：🟢 allow（none / none）理由：…`
- Violations get `🟡 flag` / `🔴 remove`; with `DISCORD_DELETE_REMOVED=1`
  the removed message is deleted from the channel.
- Commands (in the channel):
  - `!review` — review the **whole pending queue** (loops batch by batch
    until drained) and post every verdict
  - `!audit` — full sweep: queue → escalation review → health digest,
    one command
  - `!flagged` — list posts waiting for **human review** (flag rulings)
  - `!decide <postId> <allow|flag|remove> [note]` — human ruling; the
    correction is taught back to the Mind (override loop)
  - `!blacklist add|remove|list <term>` — manage the instant
    auto-delete dictionary from chat (takes effect immediately)
  - `!stats` — member violation stats
  - `!digest` — today's community-health report from the Mind
  - `!help` — command list

## Instant blacklist & whitelist (auto-handled dictionaries)

Two term dictionaries at the project root (one term per line, `#` =
comment, case-insensitive substring match — English and Chinese both
work):

- **`blacklist.txt`** — a message containing a blacklisted term is
  **removed instantly on ingest** — no Mind call, no 30–90 s wait —
  with reason `Blacklisted term: "…"`.
- **`whitelist.txt`** — a message containing a whitelisted term is
  **allowed instantly** (reason `Whitelisted term: "…"`), protecting
  known-safe vocabulary from being re-judged. The blacklist is checked
  first and wins (safety first).

**The Mind learns both dictionaries.** Its review schema includes an
optional `keywords` field; when it rules a post it can name the words
that drove the ruling — the app files them into the blacklist
(`remove`) or whitelist (`allow`) automatically, so the next identical
message is handled instantly with zero cognition.

- Edit the files any time; changes take effect immediately (no restart).
- Manage from Discord: `!blacklist add|remove|list <term>` and
  `!whitelist add|remove|list <term>`.
- Black/whitelist hits bypass the Mind entirely — good for
  high-volume channels and for protecting your demo from slow rounds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✖ DISCORD_TOKEN is not set` | Token missing in `.env` |
| Login fails / "Invalid token" | Reset the token in the Developer Portal and re-copy |
| Bot joins but sees no messages | Enable **MESSAGE CONTENT INTENT** (step 1.3) and re-invite |
| "could not delete" in logs | Bot lacks **Manage Messages**; regenerate the invite with it |
| `⚠️ Hearthkeeper 服务未连接` | `npm start` isn't running in terminal 1 |
| Bot replies in a language you don't want | Add `Always reply in English.` to the Mind's instructions (hellominds.ai) |

## Notes

- **Cost**: each review batch is one cognition turn on the Mind; a busy
  channel costs more. Watch the ⚡ balance in the dashboard header.
- **Privacy**: message text is stored in the local SQLite audit log and
  sent to the Minds platform for review. Don't connect bots to channels
  with sensitive content you can't share with the model provider.
- The bot is single-server by design; channel filtering keeps it from
  moderating channels you didn't choose.
