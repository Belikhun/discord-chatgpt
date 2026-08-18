import { ChatInputCommandInteraction } from "discord.js";

/**
 * Message-like adapter that wraps a slash command interaction so it can be
 * fed into ChatConversation / ChatCompletion, which are built around
 * Discord Message objects.
 *
 * All outgoing traffic is routed through the interaction webhook
 * (reply / editReply / followUp / webhook.editMessage). This is required for
 * personal (user-installed) app contexts, where the bot has no access to the
 * underlying channel and cannot send or edit messages directly.
 */
export class InteractionMessage {
	/**
	 * Create a new interaction message adapter.
	 *
	 * @param	{ChatInputCommandInteraction}	interaction
	 * @param	{string}						content		The user's prompt text.
	 */
	constructor(interaction, content) {
		this.interaction = interaction;
		this.id = interaction.id;
		this.content = content;
		this.author = interaction.user;
		this.member = interaction.member || null;
		this.guild = interaction.guild || null;

		/** @type {Map<string, never>} */
		this.attachments = new Map();
		this.components = [];
		this.reference = null;
		this.mentions = {
			users: new Map(),
			roles: new Map(),
			members: new Map()
		};

		this.channel = {
			id: interaction.channelId,
			name: interaction.channel?.name || `${interaction.user.displayName}'s chat`,
			guild: interaction.guild || null,
			sendTyping: async () => {},
			send: async (payload) => {
				const message = await this.interaction.followUp(payload);
				return this.wrapWebhookMessage(message.id);
			}
		};
	}

	/**
	 * Wrap a webhook (follow-up) message so `.edit()` goes through the
	 * interaction webhook instead of the channel API, which the bot may not
	 * have access to in user-installed app contexts.
	 *
	 * @param	{string}	messageId
	 */
	wrapWebhookMessage(messageId) {
		return {
			id: messageId,
			edit: (payload) => this.interaction.webhook.editMessage(messageId, payload)
		};
	}

	/**
	 * Send the initial response for this interaction. Returned object exposes
	 * `.edit()` which maps to editing the original interaction reply.
	 *
	 * @param	{object}	payload
	 */
	async reply(payload) {
		await this.interaction.reply(payload);

		return {
			id: null,
			edit: (p) => this.interaction.editReply(p)
		};
	}
}
