import type { IncomingMessage } from "../conversation/types";
import type { BridgeChatEvent } from "./client";

const EMPTY = new Map<string, never>();

/** Exported keys that only restate identity or chat formatting. */
const NOISE_KEYS = /^(luckperms_|vault_|player_displayname$|player_prefix$|player_suffix$)/;

/** Spelling-insensitive name match: case and Vietnamese diacritics ignored. */
export function fold(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
}

/** When a line was sent, in the network's own time zone, so the model knows what "today" is. */
function localTime(epochMs: number): string {
	return new Date(epochMs || Date.now()).toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).replace(" ", "T") + "+07:00";
}

/** A bridged chat line as an incoming message. */
export function minecraftMessage(event: BridgeChatEvent, channel: any, botName: string): IncomingMessage {
	const fromDiscord = event.source === "discord";
	const name = fromDiscord
		? (event.author?.name || "Discord")
		: (event.player?.name || "player");
	const authorId = fromDiscord
		? `discord:${event.author?.id || name}`
		: (event.player?.uuid || name);
	const mentionsBot = fold(event.message).includes(`@${fold(botName)}`);

	const status: Record<string, string> = {};
	for (const [key, value] of Object.entries(event.values ?? {})) {
		if (!NOISE_KEYS.test(key) && value !== "")
			status[key] = value;
	}

	return {
		id: event.id,
		content: event.message,
		author: { id: authorId, username: name, displayName: event.player?.display || name, bot: false } as any,
		member: null,
		guild: null,
		channel,
		attachments: EMPTY,
		components: [],
		reference: null,
		mentions: { users: EMPTY, roles: EMPTY, members: null },
		mentionsBot,

		async reply(payload: any) {
			return channel.send(payload);
		},

		describe() {
			if (fromDiscord) {
				return {
					source: "discord",
					sentAt: localTime(event.time),
					author: { name, username: event.author?.username || name },
					online: event.audience.slice(0, 50),
					message: event.message
				};
			}

			const player = event.player!;

			return {
				source: "minecraft",
				sentAt: localTime(event.time),
				server: event.server,
				player: {
					name: player.name,
					uuid: player.uuid,
					display: player.display,
					group: player.groupDisplay || player.group,
					ping: player.ping,
					client: player.client,
					onlineMinutes: player.sessionMillis !== undefined ? Math.round(player.sessionMillis / 60_000) : undefined
				},
				status: Object.keys(status).length > 0 ? status : undefined,
				online: event.audience.slice(0, 50),
				message: event.message
			};
		},

		onBehalfOf() {
			return fromDiscord
				? { label: `${name} (Discord via Minecraft chat)`, discordUser: event.author?.id, channel: channel.id }
				: { label: `${name} (Minecraft)`, minecraftPlayer: event.player?.uuid, minecraftName: name, server: event.server?.name, channel: channel.id };
		}
	};
}
