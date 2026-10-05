import {
	forgetMemory,
	listMemories,
	saveMemory,
	searchMemories,
	updateMemory,
	userScopeId,
	type Memory,
	type MemoryScopeKind,
	type MemoryViewer
} from "../stores/memory";
import type { Tool, ToolContext } from "./types";

/**
 * Who the current request is, for memory visibility. Derived from the
 * conversation and the message only, never from model arguments, which is
 * what keeps one server's memories out of another's.
 */
export function memoryViewer(context: ToolContext): MemoryViewer {
	const channel = context?.conversation?.channel;

	return {
		guildId: channel?.guild?.id ?? channel?.memoryGuildId ?? null,
		channelId: channel?.id ?? null,
		userId: context?.message?.author?.id ?? null
	};
}

/** A memory as the model sees it: no internal ids beyond the one it can act on. */
export function presentMemory(memory: Memory): Record<string, any> {
	return {
		id: memory.id,
		scope: memory.scope.kind === "guild" ? "server" : memory.scope.kind,
		about: memory.scope.kind === "user" ? memory.scope.id.split(":")[1] : undefined,
		content: memory.content,
		tags: memory.tags,
		pinned: memory.pinned || undefined,
		updatedAt: new Date(memory.updatedAt).toISOString(),
		expiresAt: memory.expiresAt ? new Date(memory.expiresAt).toISOString() : undefined
	};
}

const SCOPES: Record<string, MemoryScopeKind> = { user: "user", channel: "channel", server: "guild" };

export const saveMemoryTool: Tool = {
	definition: {
		name: "memory_save",
		description: "Remember something for future conversations. Use scope \"user\" for facts about a person (preferences, what they are working on), \"channel\" for this channel's ongoing context, \"server\" for facts the whole server shares. Write one self-contained fact per memory. Memories do not expire unless ttlSeconds is set.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				scope: {
					type: "string",
					enum: ["user", "channel", "server"],
					description: "Who the memory is about and who will see it."
				},
				content: {
					type: "string",
					description: "The fact to remember, phrased so it makes sense on its own later."
				},
				aboutUserId: {
					type: ["string", "null"],
					description: "For scope \"user\": the Discord user ID it is about. Null means the person who sent the current message."
				},
				tags: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Optional short keywords."
				},
				pinned: {
					type: ["boolean", "null"],
					description: "Pinned memories are always recalled in their scope. Use sparingly, for standing rules."
				},
				ttlSeconds: {
					type: ["number", "null"],
					description: "Forget after this many seconds. Null keeps it until it is forgotten."
				}
			},
			required: ["scope", "content", "aboutUserId", "tags", "pinned", "ttlSeconds"],
			additionalProperties: false
		}
	},

	async execute({ scope, content, aboutUserId, tags, pinned, ttlSeconds }, context: ToolContext) {
		const viewer = memoryViewer(context);
		const kind = SCOPES[scope];

		if (!kind)
			return { ok: false, error: `Unknown scope: ${scope}` };

		let scopeId: string | null;

		if (kind === "user") {
			const userId = aboutUserId || viewer.userId;
			scopeId = userId ? userScopeId(viewer.guildId, userId) : null;
		} else if (kind === "channel") {
			scopeId = viewer.channelId;
		} else {
			scopeId = viewer.guildId;
		}

		if (!scopeId)
			return { ok: false, error: `There is no ${scope} to attach this memory to here.` };

		const memory = await saveMemory({
			scope: { kind, id: scopeId },
			guildId: viewer.guildId,
			content,
			tags,
			pinned: !!pinned,
			ttlSeconds,
			authorId: viewer.userId,
			sourceChannelId: viewer.channelId,
			sourceMessageId: context?.message?.id ?? null
		});

		return { ok: true, memory: presentMemory(memory) };
	}
};

export const searchMemoryTool: Tool = {
	definition: {
		name: "memory_search",
		description: "Search memories about the current person, this channel and this server, by meaning and by keywords. Relevant memories are already recalled automatically; search when you need something specific.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look for, in natural language." },
				limit: { type: ["number", "null"], description: "Maximum results (default 8)." }
			},
			required: ["query", "limit"],
			additionalProperties: false
		}
	},

	async execute({ query, limit }, context: ToolContext) {
		if (!query?.trim())
			return { ok: false, error: "Search query cannot be empty." };

		const hits = await searchMemories(query, memoryViewer(context), Math.max(1, Math.min(30, limit ?? 8)));
		return { ok: true, count: hits.length, items: hits.map((hit) => presentMemory(hit.memory)) };
	}
};

export const listMemoryTool: Tool = {
	definition: {
		name: "memory_list",
		description: "List recent memories visible here, optionally of one scope.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				scope: { type: ["string", "null"], enum: ["user", "channel", "server", null], description: "Only this scope." },
				limit: { type: ["number", "null"], description: "Maximum results (default 20)." }
			},
			required: ["scope", "limit"],
			additionalProperties: false
		}
	},

	async execute({ scope, limit }, context: ToolContext) {
		const kind = scope ? SCOPES[scope] ?? null : null;
		const items = listMemories(memoryViewer(context), { kind, limit: limit ?? 20 });

		return { ok: true, count: items.length, items: items.map(presentMemory) };
	}
};

export const updateMemoryTool: Tool = {
	definition: {
		name: "memory_update",
		description: "Correct or extend a memory (by id from memory_search or the recalled list) when a fact changed.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Memory id." },
				content: { type: ["string", "null"], description: "The new text, or null to keep it." },
				tags: { type: ["array", "null"], items: { type: "string" }, description: "Replacement tags, or null to keep them." },
				pinned: { type: ["boolean", "null"], description: "Pin or unpin, or null to keep it." }
			},
			required: ["id", "content", "tags", "pinned"],
			additionalProperties: false
		}
	},

	async execute({ id, content, tags, pinned }, context: ToolContext) {
		const memory = await updateMemory(id, { content, tags, pinned }, memoryViewer(context));

		return memory
			? { ok: true, memory: presentMemory(memory) }
			: { ok: false, error: `No memory ${id} is visible here.` };
	}
};

export const forgetMemoryTool: Tool = {
	definition: {
		name: "memory_forget",
		description: "Delete a memory that is wrong, obsolete, or that someone asked you to forget.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Memory id." }
			},
			required: ["id"],
			additionalProperties: false
		}
	},

	async execute({ id }, context: ToolContext) {
		const memory = forgetMemory(id, memoryViewer(context));

		return memory
			? { ok: true, forgotten: id }
			: { ok: false, error: `No memory ${id} is visible here.` };
	}
};

/** Memory tools, in the order they are offered. */
export const memoryTools: Tool[] = [saveMemoryTool, searchMemoryTool, listMemoryTool, updateMemoryTool, forgetMemoryTool];
