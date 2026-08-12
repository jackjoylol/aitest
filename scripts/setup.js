// scripts/setup.js — verify the Minds connection and bind the
// conversation alias. Run once after creating your Mind + API key:
//
//   npm run setup
//
// Prints: your Minds, the resolved Mind, the bound alias, cognition
// balance. Idempotent (ensureConversation is safe to re-run).

import config from "../src/config.js";
import { getMinds, resolveMind, MindError } from "../src/minds.js";

if (config.mock) {
  console.log("HEARTHKEEPER_MOCK=1 is set — setup only applies to the real Minds platform.");
  console.log("Unset it (or set HEARTHKEEPER_MOCK=0) to connect your real Mind.");
  process.exit(0);
}

if (!config.builderApiKey) {
  console.error("✖ MINDS_BUILDER_API_KEY is not set.");
  console.error("  1. Create a Mind at hellominds.ai/profile");
  console.error("  2. Create a Builder API key in the Builder console");
  console.error("  3. Copy it into your .env file (see .env.example)");
  process.exit(1);
}

try {
  const minds = await getMinds();
  const list = await minds.listMinds();
  console.log(`Minds on this account: ${list.length}`);
  for (const m of list) {
    console.log(`  • ${m.name} (${m.mindId}) — model: ${m.model ?? "?"}`);
  }

  const mind = await resolveMind(minds);
  console.log(`\nResolved Mind: ${mind.name} (${mind.mindId})`);

  const conv = await minds.ensureConversation(config.alias, mind.mindId);
  console.log(`Conversation alias "${config.alias}" bound → ${conv.id ?? conv.conversationId ?? "(see console)"}`);

  const balance = await minds.getCognitionBalance(mind.mindId);
  console.log(`Cognition balance: ${balance.cognition}`);

  console.log("\n✔ Setup complete. Run `npm start` (engine), then `npm run discord` (bot) — or open the dashboard.");
} catch (err) {
  if (err instanceof MindError) {
    console.error(`✖ Minds error [${err.code ?? err.status ?? "?"}]: ${err.message}`);
  } else {
    console.error(`✖ ${err.message}`);
  }
  process.exit(1);
}
