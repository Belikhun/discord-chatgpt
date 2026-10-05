import { describe, expect, test } from "bun:test";
import { getToolDefinitions } from "../src/tools/registry";
import { minecraftMessage, fold } from "../src/minecraft/message";
import { BossbarProgress } from "../src/minecraft/progress";
import type { BridgeChatEvent } from "../src/minecraft/client";

function chatEvent(overrides: Partial<BridgeChatEvent> = {}): BridgeChatEvent {
	return {
		id: "m1",
		source: "minecraft",
		time: Date.UTC(2026, 9, 5, 12, 0, 0),
		message: "chào @Bụt ơi",
		audience: ["nene8920_vn", "be"],
		player: { uuid: "u-1", name: "nene8920_vn", display: "[Mod] nene8920_vn", prefix: "[Mod]", group: "mod", groupDisplay: "Mod", ping: 40, client: "1.21.11", sessionMillis: 600_000 },
		server: { name: "survival", display: "Sinh Tồn" },
		values: { player_x: "12", luckperms_prefix: "[Mod]", player_displayname: "nene", luna_player_dimension: "overworld" },
		...overrides
	};
}

describe("minecraft message adapter", () => {
	test("describes the speaker, their status and the local time, dropping formatting keys", () => {
		const message = minecraftMessage(chatEvent(), { id: "mc:network" }, "Bụt");
		const described = message.describe!();

		expect(described.source).toBe("minecraft");
		expect(described.player.name).toBe("nene8920_vn");
		expect(described.player.onlineMinutes).toBe(10);
		expect(described.status).toEqual({ player_x: "12", luna_player_dimension: "overworld" });
		expect(described.sentAt).toBe("2026-10-05T19:00:00+07:00");
		expect(message.author.id).toBe("u-1");
	});

	test("an @mention of the bot is found whatever the diacritics", () => {
		expect(minecraftMessage(chatEvent({ message: "@but giúp với" }), {}, "Bụt").mentionsBot).toBe(true);
		expect(minecraftMessage(chatEvent({ message: "bụt ơi" }), {}, "Bụt").mentionsBot).toBe(false);
		expect(fold("Mèo Béo đây")).toBe("meo beo day");
	});

	test("a relayed Discord message names its Discord author", () => {
		const message = minecraftMessage(chatEvent({ source: "discord", player: undefined, server: undefined, author: { id: "42", name: "Be", username: "be", nickname: "Be" } }), { id: "mc:network" }, "Bụt");

		expect(message.describe!().author).toEqual({ name: "Be", username: "be" });
		expect(message.onBehalfOf!().discordUser).toBe("42");
		expect(message.author.id).toBe("discord:42");
	});
});

describe("minecraft tools", () => {
	test("Discord-only tools are withheld from Minecraft chat", async () => {
		const names = (await getToolDefinitions({ conversation: { channel: { id: "mc:network", platform: "minecraft" } } as any })).map((d) => d.name);

		expect(names).toContain("web_search");
		expect(names).toContain("memory_save");
		expect(names).not.toContain("react_message");
		expect(names).not.toContain("list_emojis");
		expect(names).not.toContain("get_server_info");
	});
});

describe("boss bar progress", () => {
	function recorder() {
		const posts: Record<string, any>[] = [];
		const client = { post: async (_path: string, body: Record<string, any>) => { posts.push(body); return {}; } };
		const progress = new BossbarProgress(client as any, "mc:network", () => "Bụt", () => ({ players: ["u-1"] }));
		return { posts, progress };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 1_700));

	test("a turn nobody asked for and that used no tools shows nothing", async () => {
		const { posts, progress } = recorder();

		progress.start(false);
		progress.end(false);
		await settle();

		expect(posts).toEqual([]);
	});

	test("an addressed turn shows, names its tool, finishes green and hides, always to its audience", async () => {
		const { posts, progress } = recorder();

		progress.start(true);
		progress.tools([{ id: "c1", name: "web_search", arguments: "{}" } as any]);
		progress.toolsDone([{ id: "c1", name: "web_search", arguments: "{}" } as any], [{ kind: "tool_result", callId: "c1", output: "{\"ok\":true}" }]);
		progress.end(true);
		await settle();

		expect(posts.map((post) => post.action)).toEqual(["show", "show", "show", "show", "hide"]);
		expect(posts[1]!.title).toContain("tìm kiếm trên web");
		expect(posts.at(-2)!.color).toBe("green");
		expect(new Set(posts.map((post) => post.id)).size).toBe(1);

		for (const post of posts.filter((entry) => entry.action === "show"))
			expect(post.players).toEqual(["u-1"]);
	});

	test("a failed tool turns the bar red", async () => {
		const { posts, progress } = recorder();

		progress.start(false);
		progress.tools([{ id: "c1", name: "luna__player_lookup", arguments: "{}" } as any]);
		progress.toolsDone([], [{ kind: "tool_result", callId: "c1", output: "{\"ok\":false,\"error\":\"x\"}" }]);
		progress.end(false);
		await settle();

		expect(posts[0]!.title).toContain("luna › player_lookup");
		expect(posts[1]!.color).toBe("red");
		expect(posts.at(-1)!.action).toBe("hide");
	});
});
