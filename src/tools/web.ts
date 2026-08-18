import { fetchWebpage } from "../stores/webpage";
import type { Tool } from "./types";

export const fetchWebpageTool: Tool = {
	definition: {
		name: "fetch_webpage",
		description: "Fetch a webpage by URL and return its content converted to compact, AI-friendly markdown. Long documents are returned in chunks: when the result is truncated, call again with startIndex set to the previous result's endIndex to continue reading.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Absolute http(s) URL of the webpage to fetch."
				},
				maxLength: {
					type: ["number", "null"],
					description: "Maximum number of markdown characters to return per call (default 8000, max 20000)."
				},
				startIndex: {
					type: ["number", "null"],
					description: "Character offset to start reading from, used to page through long documents. If null, start from the beginning."
				}
			},
			required: ["url", "maxLength", "startIndex"],
			additionalProperties: false
		}
	},

	async execute({ url, maxLength, startIndex }) {
		try {
			return await fetchWebpage(url, { maxLength, startIndex });
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	}
};
