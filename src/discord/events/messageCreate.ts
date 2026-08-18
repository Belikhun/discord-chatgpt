import { DMChannel, type Message } from "discord.js";
import { log } from "../../logger";
import { emoji } from "../../format";
import { discord } from "../client";
import { isChannelBlacklisted } from "../blacklist";
import { buildErrorEmbed } from "../errorEmbed";
import { getConversation, setConversation } from "../../conversation/store";
import { resolveConversation } from "../../conversation/resolve";

export async function handleMessageCreate(message: Message): Promise<void> {
	// if (message.author.bot)
	// 	return;
	if (message.author.id === discord.user!.id)
		return;

	if (message.guild && isChannelBlacklisted(message.channelId))
		return;

	if (!message.content && !message.attachments.size && !message.components.length)
		return;

	if (message.content.startsWith("*clear") || message.content.startsWith("/clear")) {
		let count = 0;

		for (const key of [message.channelId, `b:${message.channelId}`]) {
			count += getConversation(key)?.history.length || 0;
			setConversation(key, null);
		}

		await message.reply({
			content: `${emoji("acinfo")} ${count} chat context ở trong kênh này đã được loại bỏ!`
		});

		return;
	}

	const channelName = (message.channel instanceof DMChannel)
		? `${message.author.displayName}'s DM`
		: (message.channel as any).name;

	log.debug(`▼ Tin nhắn mới: \"${message.content}\" từ ${channelName} [${message.channelId}] bởi ${message.author.displayName} [${message.author.id}]`);

	try {
		const conversation = resolveConversation(message.channel as any);
		await conversation.handle(message as any);
	} catch (e: any) {
		const embed = buildErrorEmbed(e, {
			actorName: message.author.displayName,
			actorIcon: message.author.displayAvatarURL()
		});

		log.error(e);

		try {
			await message.reply({ embeds: [embed] });
		} catch (sendErr: any) {
			log.error(`Failed to send error embed in channel ${message.channelId}: ${sendErr.message}`);
		}
	}
}
