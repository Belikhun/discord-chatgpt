import { fetchWebpage } from "../stores/webpage";
import { webSearch } from "../stores/websearch";
import type { Tool } from "./types";

export const webSearchTool: Tool = {
	timeoutMs: 45_000,
	definition: {
		name: "web_search",
		description: "Search the web for current information: news, releases, documentation, prices, anything that may have changed since your training or that you are unsure of. Returns ranked results (title, url, snippet) and, from some backends, a short sourced summary. Search first, then read the most relevant result with fetch_webpage when the snippet is not enough. Write the query the way you would type it into a search engine.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The search query."
				},
				count: {
					type: ["number", "null"],
					description: "How many results to return (default 6, max 10)."
				},
				freshness: {
					type: ["string", "null"],
					enum: ["day", "week", "month", "year", null],
					description: "Only results published within this period. Null for any time."
				},
				site: {
					type: ["string", "null"],
					description: "Restrict results to one domain, e.g. \"docs.papermc.io\". Null for the whole web."
				}
			},
			required: ["query", "count", "freshness", "site"],
			additionalProperties: false
		}
	},

	async execute({ query, count, freshness, site }) {
		if (!String(query || "").trim())
			return { ok: false, error: "query is required." };

		try {
			const outcome = await webSearch(String(query), { count, freshness, site });

			return {
				ok: true,
				query,
				provider: outcome.provider,
				...(outcome.summary ? { summary: outcome.summary } : {}),
				results: outcome.results
			};
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};

export const fetchWebpageTool: Tool = {
	definition: {
		name: "fetch_webpage",
		description: "Read a webpage by URL as compact markdown. By default only the page's main content is returned (navigation, ads, cookie banners, scripts and images removed), which is what you want for articles, docs and posts; use mode \"full\" for pages whose content is not one article (listings, tables, dashboards). Long documents come in chunks: when truncated, call again with startIndex set to the previous endIndex, or to a heading's startIndex from outline to jump to a section. Links within the same site are written as paths relative to finalUrl.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Absolute http(s) URL of the webpage to read."
				},
				maxLength: {
					type: ["number", "null"],
					description: "Most markdown characters to return per call (default 8000, max 20000)."
				},
				startIndex: {
					type: ["number", "null"],
					description: "Character offset to start reading from. Null to start at the beginning."
				},
				mode: {
					type: ["string", "null"],
					enum: ["article", "full", null],
					description: "\"article\" (default) for the main content, \"full\" for the whole page minus its chrome."
				},
				links: {
					type: ["boolean", "null"],
					description: "Keep link URLs (default true). False turns links into plain text, which is shorter."
				},
				images: {
					type: ["boolean", "null"],
					description: "Keep images as markdown (default false)."
				}
			},
			required: ["url", "maxLength", "startIndex", "mode", "links", "images"],
			additionalProperties: false
		}
	},

	async execute({ url, maxLength, startIndex, mode, links, images }) {
		try {
			return await fetchWebpage(url, { maxLength, startIndex, mode, links, images });
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};
