import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	SlashCommandBuilder
} from "discord.js";
/**
 * Build the guild-scoped commands (JSON) used by the Discord API.
 */
export function buildCommands(): any[] {
	const commands = [
		new SlashCommandBuilder()
			.setName("clear")
			.setDescription("Xóa toàn bộ context tin nhắn trong một kênh"),

		new SlashCommandBuilder()
			.setName("model")
			.setDescription("Đặt model sẽ sử dụng cho kênh hiện tại")
			.addStringOption((option) => {
				// Autocompleted instead of a fixed choice list: the combined
				// catalogue of every configured provider exceeds Discord's
				// 25-choice limit for options.
				return option.setName("model")
					.setDescription("Tên model sẽ sử dụng (gõ để tìm kiếm)")
					.setRequired(true)
					.setAutocomplete(true);
			}),

		new SlashCommandBuilder()
			.setName("mode")
			.setDescription("Đặt chế độ trả lời tin nhắn")
			.addStringOption((option) => {
				return option.setName("mode")
					.setDescription("Chế độ phản hồi")
					.setRequired(true)
					.addChoices(
						{ name: "Tin nhắn", value: "chat" },
						{ name: "Trợ lý", value: "assistant" }
					);
			}),

		new SlashCommandBuilder()
			.setName("reasoning")
			.setDescription("Đặt mức độ suy luận cho model ở kênh hiện tại")
			.addStringOption((option) => {
				return option.setName("effort")
					.setDescription("Mức độ suy luận sẽ dùng cho các model hỗ trợ reasoning")
					.setRequired(true)
					.addChoices(
						{ name: "Tối thiểu", value: "minimal" },
						{ name: "Thấp", value: "low" },
						{ name: "Trung bình", value: "medium" },
						{ name: "Cao", value: "high" }
					);
			}),

		new SlashCommandBuilder()
			.setName("blacklist")
			.setDescription("Quản lý danh sách chặn bot theo kênh")
			.addChannelOption((option) => {
				return option
					.setName("channel")
					.setDescription("Kênh cần chặn. Nếu bỏ trống sẽ dùng kênh hiện tại.")
					.setRequired(false)
					.addChannelTypes(
						ChannelType.GuildText,
						ChannelType.GuildAnnouncement,
						ChannelType.PublicThread,
						ChannelType.PrivateThread
					);
			}),

		new SlashCommandBuilder()
			.setName("blacklist_remove")
			.setDescription("Gỡ chặn bot phản hồi trong một kênh văn bản")
			.addChannelOption((option) => {
				return option
					.setName("channel")
					.setDescription("Kênh cần gỡ chặn. Nếu bỏ trống sẽ dùng kênh hiện tại.")
					.setRequired(false)
					.addChannelTypes(
						ChannelType.GuildText,
						ChannelType.GuildAnnouncement,
						ChannelType.PublicThread,
						ChannelType.PrivateThread
					);
			}),

		new SlashCommandBuilder()
			.setName("nickname")
			.setDescription("Đặt nickname cho bot trong máy chủ hiện tại")
			.addStringOption((option) => {
				return option.setName("name")
					.setDescription("Nickname mới cho bot")
					.setRequired(true);
			}),
	];

	// Convert builders to plain JSON for the REST API
	return commands.map((c) => c.toJSON());
}

/**
 * Build global commands (JSON) used by the Discord API. These are registered
 * globally so they are available in personal (user-installed) app contexts:
 * bot DMs, group DMs and servers where only the user installed the app.
 */
export function buildGlobalCommands(): any[] {
	const commands = [
		new SlashCommandBuilder()
			.setName("b")
			.setDescription("Hỏi trợ lý AI và nhận phản hồi ngay trong kênh chat hiện tại")
			.setIntegrationTypes(
				ApplicationIntegrationType.GuildInstall,
				ApplicationIntegrationType.UserInstall
			)
			.setContexts(
				InteractionContextType.Guild,
				InteractionContextType.BotDM,
				InteractionContextType.PrivateChannel
			)
			.addStringOption((option) => {
				return option.setName("message")
					.setDescription("Nội dung tin nhắn gửi tới trợ lý")
					.setRequired(true);
			})
			.addStringOption((option) => {
				return option.setName("model")
					.setDescription("Model sẽ sử dụng cho lượt hỏi này (mặc định dùng model của kênh)")
					.setRequired(false)
					.setAutocomplete(true);
			})
			.addStringOption((option) => {
				return option.setName("thinking")
					.setDescription("Mức độ suy luận cho các model hỗ trợ reasoning")
					.setRequired(false)
					.addChoices(
						{ name: "Tối thiểu", value: "minimal" },
						{ name: "Thấp", value: "low" },
						{ name: "Trung bình", value: "medium" },
						{ name: "Cao", value: "high" }
					);
			}),

		// DM/private-context version of /clear. Guilds already get a
		// guild-scoped /clear, so this one is limited to private contexts
		// to avoid showing a duplicated command in servers.
		new SlashCommandBuilder()
			.setName("clear")
			.setDescription("Xóa toàn bộ context tin nhắn trong cuộc trò chuyện hiện tại")
			.setIntegrationTypes(
				ApplicationIntegrationType.GuildInstall,
				ApplicationIntegrationType.UserInstall
			)
			.setContexts(
				InteractionContextType.BotDM,
				InteractionContextType.PrivateChannel
			),
	];

	return commands.map((c) => c.toJSON());
}
