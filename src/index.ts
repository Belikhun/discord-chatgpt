import "./ai";
import { authenticateDiscordClient } from "./discord/client";
import { registerEvents } from "./discord/events";

//* ===========================================================
//*  Bring the bot online
//* -----------------------------------------------------------
//*  Register event handlers, then login to the bot and make
//*  it online.
//* ===========================================================

registerEvents();

await authenticateDiscordClient();
