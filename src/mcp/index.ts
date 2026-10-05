import { scope } from "../logger";
import { registerToolSource } from "../tools/registry";
import type { Tool, ToolContext } from "../tools/types";
import { registerContextSource } from "../conversation/contextSources";
import { listMcpServers, type McpServer } from "./config";
import { resolveMcpState, type McpLocation } from "./enablement";
import { McpConnection, type RemoteTool } from "./client";
import { minecraftMcpServers } from "../minecraft/config";
import { sanitizeToolName, sanitizeToolSchema } from "./schema";

const log = scope("mcp");

/** The `_meta` key luna (and any server that cares) reads the requester from. */
export const ON_BEHALF_OF_META = "dev.belikhun.luna/onBehalfOf";

const connections = new Map<string, McpConnection>();

export function connectionFor(server: McpServer): McpConnection {
	let connection = connections.get(server.id);

	if (!connection) {
		connection = new McpConnection(server);
		connections.set(server.id, connection);
	}

	return connection;
}

export function locationOf(context: ToolContext): McpLocation {
	const channel = context.conversation?.channel;

	return {
		guildId: channel?.guild?.id ?? null,
		channelId: channel?.id ?? null
	};
}

/**
 * Servers switched on where this request comes from. Minecraft chat has no
 * guild or channel to enable a server in, so the bridge's own list decides.
 */
export function enabledServers(context: ToolContext): McpServer[] {
	if (context.conversation?.channel.platform === "minecraft") {
		const allowed = minecraftMcpServers();
		return listMcpServers().filter((server) => allowed.has(server.id));
	}

	const location = locationOf(context);
	return listMcpServers().filter((server) => resolveMcpState(server, location).enabled);
}

function onBehalfOf(context: ToolContext): Record<string, unknown> {
	const message = context.message;

	if (message?.onBehalfOf)
		return message.onBehalfOf();

	const channel = context.conversation?.channel;

	return {
		label: message?.author ? `${message.author.username} (Discord)` : "Discord",
		discordUser: message?.author?.id,
		guild: channel?.guild?.id,
		channel: channel?.id,
		message: message?.id
	};
}

function toTool(server: McpServer, remote: RemoteTool): Tool {
	const connection = connectionFor(server);
	const destructive = remote.annotations?.destructiveHint ? " This changes state on the server." : "";

	return {
		source: `mcp:${server.id}`,
		timeoutMs: (server.config.TIMEOUT_MS ?? 60_000) + 5_000,
		definition: {
			name: sanitizeToolName(server.prefix, remote.name),
			description: `[${server.name}] ${remote.description ?? remote.name}${destructive}`,
			parameters: sanitizeToolSchema(remote.inputSchema),
			// MCP schemas are rarely written for strict mode (optional fields,
			// open objects), and strict mode rejects the whole request over that.
			strict: false
		},

		async execute(args, context) {
			const meta = server.config.SEND_ON_BEHALF_OF === false
				? undefined
				: { [ON_BEHALF_OF_META]: onBehalfOf(context) };

			const result = await connection.callTool(remote.name, args, meta);

			return result.isError
				? { ok: false, error: result.text || "The tool reported an error." }
				: { ok: true, result: result.structured ?? result.text };
		}
	};
}

registerToolSource({
	id: "mcp",

	async tools(context) {
		const servers = enabledServers(context);

		const lists = await Promise.all(servers.map(async (server) => {
			try {
				const remote = await connectionFor(server).listTools();
				return remote.map((tool) => toTool(server, tool));
			} catch (err: any) {
				// One server being down must not take the others (or the
				// built-in tools) with it.
				log.warn(`Tools of ${server.name} unavailable: ${err?.message || err}`);
				return [];
			}
		}));

		return lists.flat();
	}
});

registerContextSource({
	id: "mcp-instructions",

	async build(context) {
		const notes: string[] = [];

		for (const server of enabledServers(context)) {
			if (server.config.USE_INSTRUCTIONS === false)
				continue;

			const instructions = connectionFor(server).instructions?.trim();
			if (!instructions)
				continue;

			notes.push(`Instructions from the MCP server "${server.name}". Its tools are offered to you named "${server.prefix}__<tool>", so a tool it calls "x" is "${server.prefix}__x" here.\n\n${instructions}`);
		}

		return notes.length ? notes.join("\n\n---\n\n") : null;
	}
});
