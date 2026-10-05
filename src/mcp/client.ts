import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { scope } from "../logger";
import type { McpServer } from "./config";

/** A tool as the server describes it. */
export interface RemoteTool {
	name: string;
	description?: string;
	inputSchema: Record<string, any>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface RemoteToolResult {
	isError: boolean;
	text: string;
	structured?: unknown;
}

/** How long a tool list is trusted before it is fetched again. */
const TOOL_LIST_TTL_MS = 5 * 60_000;

/** After a failed connect, how long before the next attempt; doubles up to the cap. */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One MCP server connection: connected on first use, its tool list cached
 * (and dropped when the server says it changed), and torn down on error so the
 * next call reconnects. A server that keeps failing is backed off rather than
 * retried on every message.
 */
export class McpConnection {
	readonly server: McpServer;
	private client: Client | null = null;
	private connecting: Promise<Client> | null = null;
	private tools: { at: number; list: RemoteTool[] } | null = null;
	private retryAt = 0;
	private retryDelay = RETRY_BASE_MS;
	private log;

	constructor(server: McpServer) {
		this.server = server;
		this.log = scope(`mcp:${server.id}`);
	}

	/** The server's `initialize` instructions, once connected. */
	get instructions(): string | undefined {
		return this.client?.getInstructions();
	}

	private async connect(): Promise<Client> {
		if (this.client)
			return this.client;

		if (Date.now() < this.retryAt)
			throw new Error(`${this.server.name} is unreachable; retrying in ${Math.ceil((this.retryAt - Date.now()) / 1000)}s`);

		this.connecting ??= (async () => {
			const client = new Client({ name: "discord-chatgpt", version: "1.0.0" });
			const transport = new StreamableHTTPClientTransport(new URL(this.server.config.URL), {
				requestInit: { headers: this.server.config.HEADERS ?? {} }
			});

			client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				this.tools = null;
			});

			client.onerror = (err) => {
				this.log.warn(`Connection error: ${err?.message || err}`);
			};

			try {
				await client.connect(transport, { timeout: 15_000 });
			} catch (err) {
				this.retryAt = Date.now() + this.retryDelay;
				this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
				throw err;
			}

			this.retryDelay = RETRY_BASE_MS;
			this.client = client;
			this.log.info(`Connected to ${this.server.name} (${client.getServerVersion()?.name ?? "unknown"} ${client.getServerVersion()?.version ?? ""}).`);

			return client;
		})().finally(() => {
			this.connecting = null;
		});

		return await this.connecting;
	}

	/** Drop the connection; the next call reconnects. */
	async reset(): Promise<void> {
		const client = this.client;

		this.client = null;
		this.tools = null;
		await client?.close().catch(() => undefined);
	}

	/** The server's tools, filtered by INCLUDE/EXCLUDE, from cache when fresh. */
	async listTools(): Promise<RemoteTool[]> {
		if (this.tools && Date.now() - this.tools.at < TOOL_LIST_TTL_MS)
			return this.tools.list;

		const client = await this.connect();
		let list: RemoteTool[];

		try {
			list = (await client.listTools(undefined, { timeout: 15_000 })).tools as RemoteTool[];
		} catch (err) {
			await this.reset();
			throw err;
		}

		const { INCLUDE_TOOLS, EXCLUDE_TOOLS } = this.server.config;

		list = list
			.filter((tool) => !INCLUDE_TOOLS || INCLUDE_TOOLS.includes(tool.name))
			.filter((tool) => !EXCLUDE_TOOLS?.includes(tool.name));

		this.tools = { at: Date.now(), list };
		return list;
	}

	/** Call a tool and flatten its content blocks to text for the model. */
	async callTool(name: string, args: Record<string, any>, meta?: Record<string, unknown>): Promise<RemoteToolResult> {
		const client = await this.connect();
		let result: Record<string, any>;

		try {
			result = await client.callTool(
				{ name, arguments: args, ...(meta ? { _meta: meta } : {}) },
				undefined,
				{ timeout: this.server.config.TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS }
			) as Record<string, any>;
		} catch (err) {
			// A protocol or transport failure may have left the session unusable.
			await this.reset();
			throw err;
		}

		const blocks: any[] = Array.isArray(result.content) ? result.content : [];
		const text = blocks
			.map((block) => {
				if (block?.type === "text")
					return block.text;

				if (block?.type === "resource" && typeof block.resource?.text === "string")
					return block.resource.text;

				return `[${block?.type ?? "unknown"} content omitted]`;
			})
			.join("\n");

		return { isError: !!result.isError, text, structured: result.structuredContent };
	}
}
