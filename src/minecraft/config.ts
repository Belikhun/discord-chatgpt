import { env } from "../env";

/**
 * The Minecraft chat bridge: luna-messenger on the network's proxy streams chat
 * out (`GET /messenger/bridge/stream`) and takes replies and boss bars back
 * (`POST /messenger/bridge/chat`, `/bossbar`). The token is the bridge's own
 * (`chat-bridge.token` in the messenger's config.yml), never the proxy's
 * forwarding secret.
 */
export interface MinecraftBridgeConfig {
	/** Defaults to true when the block exists. */
	ENABLED?: boolean;

	/** The proxy's LunaCore HTTP API, e.g. `http://10.0.0.10:32452/api`. */
	URL: string;

	TOKEN: string;

	/** The name replies are sent under; defaults to `NICKNAME_DEFAULT`. */
	NAME?: string;

	/** Extra wake-up keywords for Minecraft chat, on top of `WAKEUP_KEYWORDS`. */
	WAKEUP_KEYWORDS?: string[];

	/** Persona for Minecraft chat; defaults to `SYSTEM_ROLE_CHAT`. */
	SYSTEM_ROLE?: string;

	/** Model for Minecraft chat; defaults to the per-channel setting, then `MODEL_DEFAULT`. */
	MODEL?: string;

	/** MCP servers (ids from `MCP_SERVERS`) offered in Minecraft chat. */
	MCP_SERVERS?: string[];

	/** Treat Discord messages relayed into Minecraft as chat too. Default true. */
	FORWARD_DISCORD?: boolean;

	/** Discord channels to stay out of, on top of the ones the proxy reports bridging. */
	IGNORE_DISCORD_CHANNELS?: string[];

	BOSSBAR?: {
		/** Default true. */
		ENABLED?: boolean;

		/** Who sees the bar: the player who spoke last (default), or everyone who sees the reply. */
		AUDIENCE?: "speaker" | "channel";
	};
}

export function minecraftBridgeConfig(): MinecraftBridgeConfig | null {
	const config = env.MINECRAFT_BRIDGE;

	if (!config || config.ENABLED === false || !config.URL || !config.TOKEN)
		return null;

	return config;
}

/** MCP server ids offered to Minecraft conversations. */
export function minecraftMcpServers(): Set<string> {
	return new Set(env.MINECRAFT_BRIDGE?.MCP_SERVERS ?? []);
}

/** The name the bot speaks under in Minecraft. */
export function minecraftBotName(): string {
	return env.MINECRAFT_BRIDGE?.NAME || env.NICKNAME_DEFAULT || "Bot";
}
