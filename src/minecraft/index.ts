import config from "../config";
import { env } from "../env";
import { scope } from "../logger";
import { resolveConversation } from "../conversation/resolve";
import type { ConversationChannel } from "../conversation/types";
import { BridgeClient, type BridgeChatEvent, type BridgeHello } from "./client";
import { minecraftBotName, minecraftBridgeConfig } from "./config";
import { minecraftMessage } from "./message";
import { BossbarProgress, NO_PROGRESS } from "./progress";
import { minecraftInstructions } from "./surface";

const log = scope("minecraft-bridge");

/** The one conversation Minecraft chat has: the network channel. */
export const MINECRAFT_CONVERSATION = "mc:network";

/** The memory scope Minecraft players' and the network's memories live under. */
export const MINECRAFT_MEMORY_GUILD = "minecraft";

/** Config key remembering the bridged Discord channels across restarts. */
const BRIDGED_CHANNELS_KEY = "minecraftBridgedChannels";

let client: BridgeClient | null = null;
let channel: (ConversationChannel & { lastSpeaker?: string }) | null = null;
let bridgedChannels = new Set<string>(config.get<string[]>(BRIDGED_CHANNELS_KEY, []));

/**
 * Whether a Discord channel is one luna-messenger relays Minecraft chat into.
 * The bot stays silent there: it already hears that chat through the bridge,
 * and answering in Discord too would echo every reply back into the game.
 */
export function isBridgedDiscordChannel(channelId: string): boolean {
	if (bridgedChannels.has(channelId))
		return true;

	return (env.MINECRAFT_BRIDGE?.IGNORE_DISCORD_CHANNELS ?? []).includes(channelId);
}

function networkChannel(bridge: BridgeClient): ConversationChannel & { lastSpeaker?: string } {
	if (channel)
		return channel;

	const settings = minecraftBridgeConfig()!;
	const audience = settings.BOSSBAR?.AUDIENCE ?? "speaker";

	const created: ConversationChannel & { lastSpeaker?: string } = {
		id: MINECRAFT_CONVERSATION,
		name: "Minecraft network chat",
		guild: null,
		platform: "minecraft",
		botName: minecraftBotName(),
		surfaceInstructions: minecraftInstructions(minecraftBotName()),
		memoryGuildId: MINECRAFT_MEMORY_GUILD,

		async send(payload: any) {
			// "@ Name" from the model would not reach the proxy's mention matcher.
			const text = String(payload?.content ?? "").replace(/@\s+([A-Za-z0-9_]{3,16})\b/g, "@$1").trim();
			if (!text)
				return null;

			return await bridge.post("/messenger/bridge/chat", { name: minecraftBotName(), message: text });
		},

		async sendTyping() {}
	};

	created.progress = settings.BOSSBAR?.ENABLED === false
		? NO_PROGRESS
		: new BossbarProgress(bridge, MINECRAFT_CONVERSATION, minecraftBotName, () => (
			audience === "speaker" && created.lastSpeaker
				? { players: [created.lastSpeaker] }
				: {}
		));

	channel = created;
	return created;
}

function onHello(hello: BridgeHello): void {
	bridgedChannels = new Set(hello.discordChannels ?? []);
	config.set(BRIDGED_CHANNELS_KEY, [...bridgedChannels]);

	log.info(`Bridge says hello: ${hello.players?.length ?? 0} player(s) online, staying out of Discord channel(s) ${[...bridgedChannels].join(", ") || "(none)"}.`);
}

async function onChat(bridge: BridgeClient, event: BridgeChatEvent): Promise<void> {
	const settings = minecraftBridgeConfig();
	if (!settings)
		return;

	if (event.source === "discord" && settings.FORWARD_DISCORD === false)
		return;

	if (!event.message?.trim())
		return;

	const target = networkChannel(bridge);
	const botName = minecraftBotName();

	// Speaking to the bot by its own name is never a reason to answer itself.
	if (event.source === "minecraft" && event.player?.name?.toLowerCase() === botName.toLowerCase())
		return;

	if (event.source === "minecraft" && event.player?.uuid)
		target.lastSpeaker = event.player.uuid;

	const message = minecraftMessage(event, target, botName);
	const conversation = resolveConversation(target, { modeOverride: "chat" });

	await conversation.handle(message);
}

/** Connect to the proxy's chat stream, when `MINECRAFT_BRIDGE` is configured. */
export function startMinecraftBridge(): void {
	const settings = minecraftBridgeConfig();
	if (!settings || client)
		return;

	const bridge: BridgeClient = new BridgeClient(settings, {
		hello: onHello,
		chat: (event) => {
			onChat(bridge, event).catch((err: any) => log.error(`Minecraft chat ${event.id} failed: ${err?.message || err}`));
		}
	});

	client = bridge;
	bridge.start();
	log.info(`Minecraft chat bridge starting against ${settings.URL}.`);
}
