import { scope } from "../logger";
import type { MinecraftBridgeConfig } from "./config";

const log = scope("minecraft-bridge");

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/** The proxy's first frame on every connection. */
export interface BridgeHello {
	protocol: number;
	sender: { name: string };
	discordChannels: string[];
	servers: string[];
	players: { uuid: string; name: string; server: string }[];
}

/** One chat line, as the proxy reports it. */
export interface BridgeChatEvent {
	id: string;
	source: "minecraft" | "discord";
	time: number;
	message: string;
	audience: string[];

	/** Minecraft source only. */
	player?: {
		uuid: string;
		name: string;
		display: string;
		prefix: string;
		group: string;
		groupDisplay: string;
		ping: number;
		client: string;
		sessionMillis?: number;
	};

	/** Minecraft source only. */
	server?: { name: string; display: string };

	/** Values the player's backend exported with the line: dimension, position, health, ... */
	values?: Record<string, string>;

	/** Discord source only. */
	author?: { id: string; name: string; username: string; nickname: string };
}

export interface BridgeHandlers {
	hello(hello: BridgeHello): void;
	chat(event: BridgeChatEvent): void;
}

/**
 * The bot's end of the bridge: one event stream kept open with backoff, and
 * plain POSTs for everything sent back.
 */
export class BridgeClient {
	private readonly base: string;
	private stopped = false;
	private abort: AbortController | null = null;

	constructor(private readonly config: MinecraftBridgeConfig, private readonly handlers: BridgeHandlers) {
		this.base = config.URL.replace(/\/+$/, "");
	}

	start(): void {
		this.loop().catch((err) => log.error(`Bridge loop died: ${err?.message || err}`));
	}

	stop(): void {
		this.stopped = true;
		this.abort?.abort();
	}

	/** POST a JSON body; resolves to the response's `data`, throws on a refusal. */
	async post<T = any>(path: string, body: Record<string, any>): Promise<T> {
		const response = await fetch(`${this.base}${path}`, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${this.config.TOKEN}`,
				"content-type": "application/json"
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});

		const text = await response.text();
		let payload: any = null;

		try {
			payload = JSON.parse(text);
		} catch {
			// a non-JSON body is reported below by status
		}

		if (!response.ok)
			throw new Error(`${path} answered ${response.status}: ${payload?.error || text.slice(0, 200)}`);

		return (payload?.data ?? payload) as T;
	}

	private async loop(): Promise<void> {
		let delay = RECONNECT_MIN_MS;

		while (!this.stopped) {
			const opened = Date.now();

			try {
				await this.consume();
			} catch (err: any) {
				if (this.stopped)
					return;

				log.warn(`Stream dropped: ${err?.message || err}`);
			}

			// A connection that held for a while earns a quick reconnect; one
			// refused straight away backs off.
			delay = (Date.now() - opened > 60_000)
				? RECONNECT_MIN_MS
				: Math.min(RECONNECT_MAX_MS, delay * 2);

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	private async consume(): Promise<void> {
		this.abort = new AbortController();

		const response = await fetch(`${this.base}/messenger/bridge/stream`, {
			headers: {
				"authorization": `Bearer ${this.config.TOKEN}`,
				"accept": "text/event-stream"
			},
			signal: this.abort.signal
		});

		if (!response.ok || !response.body)
			throw new Error(`stream answered ${response.status}`);

		log.info("Connected to the Minecraft chat stream.");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();

			if (done)
				throw new Error("stream ended");

			buffer += decoder.decode(value, { stream: true });

			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				this.dispatch(frame);
			}
		}
	}

	private dispatch(frame: string): void {
		let event = "message";
		const data: string[] = [];

		for (const line of frame.split("\n")) {
			if (line.startsWith("event:"))
				event = line.slice(6).trim();
			else if (line.startsWith("data:"))
				data.push(line.slice(5).replace(/^ /, ""));
		}

		if (data.length === 0)
			return;

		let payload: any;

		try {
			payload = JSON.parse(data.join("\n"));
		} catch {
			log.warn(`Unreadable ${event} frame from the bridge.`);
			return;
		}

		try {
			if (event === "hello")
				this.handlers.hello(payload);
			else if (event === "chat")
				this.handlers.chat(payload);
		} catch (err: any) {
			log.error(`Handling ${event} failed: ${err?.message || err}`);
		}
	}
}
