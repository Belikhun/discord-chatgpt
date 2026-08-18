import { PermissionsBitField, type Guild, type GuildMember } from "discord.js";
import { log } from "../../logger";
import { emoji } from "../../format";
import { env } from "../../env";
import { resolveConversation } from "../../conversation/resolve";

const { WELCOME_INSTRUCTION_DEFAULT, WELCOME_INSTRUCTION_SERVER } = env;

function pickWelcomeChannel(guild: Guild | null): any {
	if (!guild)
		return null;

	const canSend = (channel: any) => channel.isTextBased()
		&& channel.viewable
		&& channel.permissionsFor(guild.members.me ?? guild.client.user)?.has(PermissionsBitField.Flags.SendMessages);

	if (guild.systemChannel && canSend(guild.systemChannel))
		return guild.systemChannel;

	return guild.channels.cache.find((channel) => canSend(channel)) || null;
}

export async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
	const channel = pickWelcomeChannel(member.guild);
	log.info(`Người dùng mới tham gia guild ${member.guild.id}, chọn kênh ${channel?.id || "null"} để gửi lời chào.`);

	if (!channel) {
		log.warn(`Không tìm thấy kênh phù hợp để chào mừng thành viên mới trong guild ${member.guild.id}.`);
		return;
	}

	const conversation = resolveConversation(channel);
	const welcomeTemplate = (WELCOME_INSTRUCTION_SERVER?.[member.guild.id])
		|| WELCOME_INSTRUCTION_DEFAULT
		|| "New member joined: <@{userId}> just joined {serverName}. Welcome them warmly, mention them directly, and share a quick tip about this server.";

	const welcomePayload = {
		type: "welcome",
		template: welcomeTemplate,
		data: {
			userId: member.user.id,
			username: member.user.username,
			displayName: member.displayName || member.user.username,
			serverName: member.guild.name,
			channelName: channel.name || ""
		},
		rules: [
			`Mention the member explicitly as <@${member.user.id}>`,
			"Keep it to one or two sentences.",
			"Include one quick tip about the server if possible.",
			"Reply in plain text only."
		]
	};
	const structuredWelcome = {
		currentChannel: { id: channel.id, name: channel.name },
		messageAuthor: {
			id: member.user.id,
			username: member.user.username,
			displayName: member.displayName || member.user.username
		},
		message: JSON.stringify(welcomePayload),
		event: "guild_member_join"
	};

	try {
		await conversation.handleStructuredPrompt(structuredWelcome, { activateChat: true, role: "developer" });
	} catch (e: any) {
		log.error(`Không thể gửi lời chào cho thành viên mới ${member.user.tag}: ${e.message}`);

		try {
			await channel.send(`${emoji("acerror")} Bot thiếu quyền gửi tin nhắn ở kênh này.`);
		} catch (sendErr: any) {
			log.error(`Không thể gửi thông báo lỗi trong kênh ${channel.id}: ${sendErr.message}`);
		}
	}
}
