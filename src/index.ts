import "./ai";
import "./mcp";
import "./conversation/memoryRecall";
import { scope } from "./logger";
import { authenticateDiscordClient } from "./discord/client";
import { registerEvents } from "./discord/events";
import { startMinecraftBridge } from "./minecraft";
import { backfillEmbeddings, migrateLegacyMemories, purgeExpiredMemories } from "./stores/memory";

//* ===========================================================
//*  Prepare the memory store
//* -----------------------------------------------------------
//*  Import the old memories.json once, drop what expired, and
//*  embed anything without a vector for the current model in
//*  the background.
//* ===========================================================

const log = scope("startup");

migrateLegacyMemories();
purgeExpiredMemories();
setInterval(purgeExpiredMemories, 60 * 60 * 1000);

backfillEmbeddings().catch((err) => {
	log.warn(`Embedding backfill failed: ${err?.message || err}`);
});

//* ===========================================================
//*  Bring the bot online
//* -----------------------------------------------------------
//*  Register event handlers, then login to the bot and make
//*  it online.
//* ===========================================================

registerEvents();

await authenticateDiscordClient();

//* ===========================================================
//*  Join Minecraft chat
//* -----------------------------------------------------------
//*  After login, since replies are written as the bot and the
//*  conversation layer reads the bot's own identity.
//* ===========================================================

startMinecraftBridge();
