import type { ChatInputCommandInteraction } from "discord.js";
import { code, emoji } from "../../format";
import { findMcpServer, listMcpServers, type McpServer } from "../../mcp/config";
import { canEnableAt, clearEnablement, resolveMcpState, setEnablement, type EnablementScope, type McpState } from "../../mcp/enablement";
import { connectionFor } from "../../mcp";

const AVAILABILITY_LABEL: Record<string, string> = {
	global: "dùng được ở mọi nơi",
	guild: "bật theo máy chủ",
	channel: "chỉ bật theo kênh"
};

const REASON_LABEL: Record<McpState["reason"], string> = {
	fenced: "không khả dụng ở đây",
	channel: "theo thiết lập của kênh",
	guild: "theo thiết lập của máy chủ",
	default: "bật mặc định",
	off: "chưa được bật"
};

/**
 * Who may change MCP enablement at a scope: Manage Server for the whole
 * server, Manage Channels for one channel. Read off the interaction, which
 * carries the member's resolved permissions for this channel.
 */
function mayChange(interaction: ChatInputCommandInteraction, scope: EnablementScope): boolean {
	const permission = scope === "guild" ? "ManageGuild" : "ManageChannels";
	return interaction.memberPermissions?.has(permission) ?? false;
}

function describe(server: McpServer, state: McpState): string {
	const mark = state.enabled ? emoji("acok") : emoji("acinfo");
	const status = state.enabled ? "**đang bật**" : "đang tắt";

	return `${mark} **${server.name}** ${code(server.id)}: ${status} (${REASON_LABEL[state.reason]}) · ${AVAILABILITY_LABEL[server.config.AVAILABILITY] ?? server.config.AVAILABILITY}`;
}

async function reply(interaction: ChatInputCommandInteraction, content: string, ephemeral = false): Promise<void> {
	await interaction.reply({ content, ephemeral });
}

export async function handleMcpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
	const sub = interaction.options.getSubcommand();
	const location = { guildId: interaction.guildId, channelId: interaction.channelId };

	if (sub === "list") {
		const servers = listMcpServers();

		if (servers.length === 0)
			return await reply(interaction, `${emoji("acinfo")} Chưa có máy chủ MCP nào được cấu hình.`, true);

		const lines = servers
			.map((server) => ({ server, state: resolveMcpState(server, location) }))
			.filter(({ state }) => state.reason !== "fenced")
			.map(({ server, state }) => describe(server, state));

		return await reply(interaction, lines.length ? lines.join("\n") : `${emoji("acinfo")} Không có máy chủ MCP nào khả dụng ở đây.`, true);
	}

	const server = findMcpServer(interaction.options.getString("server", true));

	if (!server || resolveMcpState(server, location).reason === "fenced")
		return await reply(interaction, `${emoji("acerror")} Không có máy chủ MCP nào như vậy khả dụng ở đây.`, true);

	if (sub === "tools") {
		await interaction.deferReply({ ephemeral: true });

		try {
			const tools = await connectionFor(server).listTools();
			const lines = tools.map((tool) => `• ${code(`${server.prefix}__${tool.name}`)}${tool.annotations?.destructiveHint ? " ⚠️" : ""}: ${(tool.description ?? "").split("\n")[0]!.slice(0, 120)}`);
			const content = lines.length ? lines.join("\n") : "Máy chủ này không cung cấp công cụ nào cho bot.";

			await interaction.editReply({ content: content.slice(0, 1990) });
		} catch (err: any) {
			await interaction.editReply({ content: `${emoji("acerror")} Không kết nối được tới **${server.name}**: ${err?.message || err}` });
		}

		return;
	}

	const scope = interaction.options.getString("scope", true) as EnablementScope;
	const scopeId = scope === "guild" ? interaction.guildId : interaction.channelId;

	if (!scopeId)
		return await reply(interaction, `${emoji("acerror")} Lệnh này chỉ dùng được trong máy chủ.`, true);

	if (!mayChange(interaction, scope)) {
		const needed = scope === "guild" ? "Quản lý máy chủ" : "Quản lý kênh";
		return await reply(interaction, `${emoji("acerror")} Bạn cần quyền ${needed} để thay đổi thiết lập này.`, true);
	}

	if (sub === "reset") {
		clearEnablement(server.id, scope, scopeId);
		return await reply(interaction, `${emoji("acinfo")} Đã bỏ lựa chọn cho **${server.name}**. ${describe(server, resolveMcpState(server, location))}`);
	}

	const enabling = sub === "enable";

	if (enabling && !canEnableAt(server, scope)) {
		const hint = scope === "guild" ? "kênh" : "máy chủ";
		return await reply(interaction, `${emoji("acerror")} **${server.name}** không thể bật ở phạm vi này; hãy bật theo ${hint}.`, true);
	}

	setEnablement(server.id, scope, scopeId, enabling, interaction.user.id);

	const state = resolveMcpState(server, location);
	const where = scope === "guild" ? "cả máy chủ" : "kênh này";
	const note = (enabling && !state.enabled)
		? "\nLưu ý: kênh này đang tắt riêng máy chủ MCP này, dùng `/mcp reset` với phạm vi kênh để áp dụng."
		: "";

	await reply(interaction, `${emoji("acinfo")} Đã ${enabling ? "bật" : "tắt"} **${server.name}** cho ${where}.\n${describe(server, state)}${note}`);
}
