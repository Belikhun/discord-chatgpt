import { listMemoriesForGuild, createMemoryForGuild } from "../stores/memory";
import { resolveGuild } from "./resolve";
import type { Tool, ToolContext } from "./types";

export const listMemoriesTool: Tool = {
	definition: {
		name: "list_memories",
		description: "List or search short-term memory items for a Discord server.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to query. If null, use the current server when available."
				},
				query: {
					type: ["string", "null"],
					description: "Search query to filter memory items by content."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of items to return."
				}
			},
			required: ["guildId", "query", "limit"],
			additionalProperties: false
		}
	},

	async execute({ guildId, query, limit }, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return listMemoriesForGuild(guild, { query, limit });
	}
};

export const createMemoryTool: Tool = {
	definition: {
		name: "create_memory",
		description: "Create a short-term memory item in the server's memory bank with an optional custom expiration duration (in seconds).",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				guildId: {
					type: ["string", "null"],
					description: "Guild ID to store memory. If null, use the current server when available."
				},
				content: {
					type: "string",
					description: "Memory content to store."
				},
				ttlSeconds: {
					type: ["number", "null"],
					description: "Expiration duration in seconds. If null, use the default duration."
				}
			},
			required: ["guildId", "content", "ttlSeconds"],
			additionalProperties: false
		}
	},

	async execute({ guildId, content, ttlSeconds }, context: ToolContext) {
		const guild = await resolveGuild(guildId, context);
		if (!guild) {
			return { ok: false, error: "Guild not found or not available in this context." };
		}

		return createMemoryForGuild(guild, { content, ttlSeconds, context });
	}
};
