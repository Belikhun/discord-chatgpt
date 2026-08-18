import { EmbedBuilder } from "discord.js";
import { bold, emoji } from "../format";
import { env } from "../env";

export function buildErrorEmbed(error: Error, { actorName, actorIcon }: { actorName?: string; actorIcon?: string } = {}): EmbedBuilder {
	const embed = new EmbedBuilder()
		.setColor(0xff6380)
		.setTitle(`${emoji("acerror")}  Có lỗi nghiêm trọng đã xảy ra!`)
		.setDescription(`${bold(error.name || "Error")} ${error.message}\n\`\`\`${error.stack}\`\`\``)
		.setTimestamp()
		.setFooter({ text: env.APP_NAME, iconURL: env.ICON });

	if (actorName || actorIcon) {
		embed.setAuthor({
			name: actorName as string,
			iconURL: actorIcon
		});
	}

	return embed;
}
