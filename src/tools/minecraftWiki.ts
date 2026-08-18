import { searchWiki, searchWikiContent, readWikiContent } from "../stores/minecraftWiki";
import type { Tool } from "./types";

export const minecraftWikiSearchTool: Tool = {
	definition: {
		name: "minecraft_wiki_search",
		description: "Search the Minecraft Wiki for pages matching a query.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search query for the wiki."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of results to return."
				}
			},
			required: ["query", "limit"],
			additionalProperties: false
		}
	},

	async execute({ query, limit }) {
		try {
			return await searchWiki(query, { limit });
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};

export const minecraftWikiSearchContentTool: Tool = {
	definition: {
		name: "minecraft_wiki_search_content",
		description: "Search the content of a Minecraft Wiki page (cached locally after first fetch).",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				pageId: {
					type: ["number", "null"],
					description: "Page ID to search."
				},
				title: {
					type: ["string", "null"],
					description: "Page title to search."
				},
				query: {
					type: "string",
					description: "Search query to match in page content."
				},
				limit: {
					type: ["number", "null"],
					description: "Maximum number of matched lines to return."
				}
			},
			required: ["pageId", "title", "query", "limit"],
			additionalProperties: false
		}
	},

	async execute({ pageId, title, query, limit }) {
		try {
			return await searchWikiContent({ pageId, title, query, limit });
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};

export const minecraftWikiReadContentTool: Tool = {
	definition: {
		name: "minecraft_wiki_read_content",
		description: "Read cached Minecraft Wiki content by line range.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				pageId: {
					type: ["number", "null"],
					description: "Page ID to read."
				},
				title: {
					type: ["string", "null"],
					description: "Page title to read."
				},
				startLine: {
					type: ["number", "null"],
					description: "Start line number (1-based)."
				},
				endLine: {
					type: ["number", "null"],
					description: "End line number (1-based)."
				}
			},
			required: ["pageId", "title", "startLine", "endLine"],
			additionalProperties: false
		}
	},

	async execute({ pageId, title, startLine, endLine }) {
		try {
			return await readWikiContent({ pageId, title, startLine, endLine });
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};
