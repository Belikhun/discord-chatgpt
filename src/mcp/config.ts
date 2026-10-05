import { env } from "../env";

/**
 * Where an MCP server may be switched on:
 *
 * - `global`: anywhere. With `DEFAULT_ENABLED` it is on everywhere unless a
 *   server or a channel turns it off; without, anyone allowed can turn it on.
 * - `guild`: off until a server admin enables it for their server; a channel
 *   can still opt out.
 * - `channel`: only ever per channel.
 *
 * `ALLOWED_GUILDS` / `ALLOWED_CHANNELS` fence a server before any of that: a
 * private server (the luna cluster) is simply absent everywhere else, whatever
 * anyone toggles.
 */
export type McpAvailability = "global" | "guild" | "channel";

/** One MCP server, as configured under `MCP_SERVERS` in env.json. */
export interface McpServerConfig {
	/** Display name; defaults to the key. */
	NAME?: string;

	/** Streamable HTTP endpoint. */
	URL: string;

	/** Extra request headers, typically `Authorization: Bearer …`. */
	HEADERS?: Record<string, string>;

	AVAILABILITY: McpAvailability;
	DEFAULT_ENABLED?: boolean;
	ALLOWED_GUILDS?: string[];
	ALLOWED_CHANNELS?: string[];

	/** Prefix for the server's tool names (`<prefix>__<tool>`); defaults to the key. */
	TOOL_PREFIX?: string;

	/** Only these tools (by the server's own names). */
	INCLUDE_TOOLS?: string[];

	/** Never these tools. */
	EXCLUDE_TOOLS?: string[];

	/** Per-call timeout; defaults to 60 s. */
	TIMEOUT_MS?: number;

	/** Inject the server's `initialize` instructions into the conversation (default true). */
	USE_INSTRUCTIONS?: boolean;

	/** Tell the server which Discord user a call is for, in `_meta` (default true). */
	SEND_ON_BEHALF_OF?: boolean;
}

export interface McpServer {
	id: string;
	name: string;
	prefix: string;
	config: McpServerConfig;
}

/** Every configured MCP server, in env.json order. */
export function listMcpServers(): McpServer[] {
	return Object.entries(env.MCP_SERVERS ?? {}).map(([id, config]) => ({
		id,
		name: config.NAME || id,
		prefix: (config.TOOL_PREFIX || id).replace(/[^a-zA-Z0-9_-]/g, "_"),
		config
	}));
}

export function findMcpServer(id: string): McpServer | null {
	return listMcpServers().find((server) => server.id === id) ?? null;
}
