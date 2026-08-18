import type { ChatInputCommandInteraction, Guild, User } from "discord.js";
import { log } from "../../logger";
import config from "../../config";
import { code, emoji } from "../../format";
import { getConversation, setConversation } from "../../conversation/store";
import { resolveAssistantConversation } from "../../conversation/resolve";
import { InteractionMessage } from "../InteractionMessage";
import { buildErrorEmbed } from "../errorEmbed";
import { isChannelBlacklisted, resolveBlacklistTargetChannel, setChannelBlacklist } from "../blacklist";

/**
 * Check if the user has Manage Messages permission in the guild.
 */
function hasManagePermission(guild: Guild | null, user: User): boolean {
	return guild?.members.cache.get(user.id)?.permissions.has("ManageMessages") || false;
}

export async function handleChatInputCommand(interaction: ChatInputCommandInteraction): Promise<void> {
	try {
		switch (interaction.commandName) {
			case "clear": {
				let count = 0;

				for (const key of [interaction.channelId, `b:${interaction.channelId}`]) {
					count += getConversation(key)?.history.length || 0;
					setConversation(key, null);
				}

				await interaction.reply({
					content: `${emoji("acinfo")} ${count} chat context ở trong kênh này đã được loại bỏ!`
				});

				break;
			}

			case "b": {
				const prompt = interaction.options.getString("message", true);
				const model = interaction.options.getString("model") || null;
				const thinking = interaction.options.getString("thinking") || null;

				const conversation = resolveAssistantConversation(interaction, { model, thinking });
				const message = new InteractionMessage(interaction, prompt);
				await conversation.handle(message);

				break;
			}

			case "model": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const model = interaction.options.getString("model", true);
				setConversation(interaction.channelId, null);
				config.set(`model.${interaction.channelId}`, model);

				await interaction.reply({
					content: `${emoji("acinfo")} Model cho kênh chat này đã được đặt thành ${code(model)}!`
				});

				break;
			}

			case "mode": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const mode = interaction.options.getString("mode", true);
				setConversation(interaction.channelId, null);
				config.set(`mode.${interaction.channelId}`, mode);

				await interaction.reply({
					content: `${emoji("acinfo")} Chế độ phản hồi cho kênh hiện tại được đặt thành ${code(mode)}!`
				});

				break;
			}

			case "reasoning": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const effort = interaction.options.getString("effort", true);
				setConversation(interaction.channelId, null);
				config.set(`reasoning.${interaction.channelId}`, effort);

				await interaction.reply({
					content: `${emoji("acinfo")} Mức độ suy luận cho kênh hiện tại đã được đặt thành ${code(effort)}. Thiết lập này sẽ được dùng khi kênh sử dụng model hỗ trợ reasoning.`
				});

				break;
			}

			case "blacklist": {
				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}

				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const targetChannel = resolveBlacklistTargetChannel(interaction);
				if (!targetChannel) {
					await interaction.reply({
						content: `${emoji("acerror")} Chỉ có thể blacklist các kênh văn bản trong máy chủ.`,
						ephemeral: true
					});

					return;
				}

				if (isChannelBlacklisted(targetChannel.id)) {
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh <#${targetChannel.id}> đã nằm trong blacklist rồi.`
					});

					return;
				}

				setChannelBlacklist(targetChannel.id, true);
				setConversation(targetChannel.id, null);

				await interaction.reply({
					content: `${emoji("acinfo")} Bot sẽ ngừng phản hồi trong kênh <#${targetChannel.id}> cho tới khi được gỡ khỏi blacklist.`
				});

				break;
			}

			case "blacklist_remove": {
				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}

				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const targetChannel = resolveBlacklistTargetChannel(interaction);
				if (!targetChannel) {
					await interaction.reply({
						content: `${emoji("acerror")} Chỉ có thể gỡ blacklist cho các kênh văn bản trong máy chủ.`,
						ephemeral: true
					});

					return;
				}

				if (!isChannelBlacklisted(targetChannel.id)) {
					await interaction.reply({
						content: `${emoji("acinfo")} Kênh <#${targetChannel.id}> hiện không nằm trong blacklist.`
					});

					return;
				}

				setChannelBlacklist(targetChannel.id, false);

				await interaction.reply({
					content: `${emoji("acinfo")} Đã gỡ kênh <#${targetChannel.id}> khỏi blacklist. Bot có thể phản hồi lại trong kênh này.`
				});

				break;
			}

			case "nickname": {
				if (!hasManagePermission(interaction.guild, interaction.user)) {
					await interaction.reply({
						content: `${emoji("acerror")} Bạn cần có quyền Quản lý tin nhắn để sử dụng lệnh này!`,
						ephemeral: true
					});

					return;
				}

				const name = interaction.options.getString("name", true);

				if (!interaction.guild) {
					await interaction.reply({
						content: `${emoji("acerror")} Lệnh này chỉ có thể sử dụng trong máy chủ!`,
						ephemeral: true
					});

					return;
				}

				const nicknames = config.get<Record<string, string>>("nicknames", {});
				nicknames[interaction.guild.id] = name;
				config.set("nicknames", nicknames);

				await interaction.reply({
					content: `${emoji("acinfo")} Nickname của bot trong máy chủ này đã được đặt thành ${code(name)}!`
				});

				break;
			}

			default: {
				log.error(`Không tìm thấy câu lệnh ${interaction.commandName}.`);
				return;
			}
		}
	} catch (e: any) {
		const embed = buildErrorEmbed(e, {
			actorName: interaction.user.displayName,
			actorIcon: interaction.user.displayAvatarURL()
		});

		log.error(e);

		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ embeds: [embed], ephemeral: true });
			} else {
				await interaction.reply({ embeds: [embed], ephemeral: true });
			}
		} catch (sendErr: any) {
			log.error(`Failed to send interaction error response: ${sendErr.message}`);
		}
	}
}
