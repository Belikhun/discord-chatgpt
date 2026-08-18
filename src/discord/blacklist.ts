import type { ChatInputCommandInteraction } from "discord.js";
import config from "../config";

export function getBlacklistedChannels(): Record<string, boolean> {
	return config.get("channelBlacklist", {});
}

export function isChannelBlacklisted(channelId: string): boolean {
	return Boolean(getBlacklistedChannels()?.[channelId]);
}

export function setChannelBlacklist(channelId: string, blacklisted: boolean): void {
	const channels = { ...getBlacklistedChannels() };

	if (blacklisted)
		channels[channelId] = true;
	else
		delete channels[channelId];

	config.set("channelBlacklist", channels);
}

export function resolveBlacklistTargetChannel(interaction: ChatInputCommandInteraction): any {
	const channel: any = interaction.options.getChannel("channel") || interaction.channel;
	if (!channel)
		return null;

	if (!channel.guildId || !channel.isTextBased?.())
		return null;

	return channel;
}
