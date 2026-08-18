import type { Logger } from "../logger";
import type { HistoryEntry } from "../ai/types";
import { ALL_EMOJIS } from "../emojis";

/**
 * Resolve `:emoji_name:` codes in a response to full Discord custom emoji
 * mentions, normalize known custom emoji mentions, and protect custom emoji
 * mentions reused verbatim from user messages.
 */
export function processOutputEmojis(text: string, reusableCustomEmojis: Set<string>, log: Logger): string {
	if (!text)
		return text;

	const protectedEmojis: string[] = [];
	let normalizedKnownEmojis = 0;
	let replacedEmojis = 0;
	let unknownEmojis = 0;
	let output = text.replaceAll(/<(a?):([a-zA-Z0-9_-]+):(\d+)>/g, (match, animatedFlag, name, emojiId) => {
		if (!reusableCustomEmojis.has(match)) {
			const lookup = ALL_EMOJIS[name] || ALL_EMOJIS[name?.toLowerCase() || ""];
			const resolvedName = ALL_EMOJIS[name] ? name : name?.toLowerCase();

			if (lookup && lookup[0] === emojiId) {
				const [, isAnimated] = lookup;
				const shouldAnimate = animatedFlag === "a" || Boolean(isAnimated);
				normalizedKnownEmojis += 1;
				return `<${shouldAnimate ? "a" : ""}:${resolvedName}:${emojiId}>`;
			}
		}

		const index = protectedEmojis.length;
		protectedEmojis.push(match);
		return `__CUSTOM_EMOJI_${index}__`;
	});

	output = output.replaceAll(/:([a-zA-Z0-9_-]+):/gi, (match, name) => {
		log.debug(`Processing emoji code: ${name}`);
		const lookup = ALL_EMOJIS[name] || ALL_EMOJIS[name?.toLowerCase() || ""];
		const resolvedName = ALL_EMOJIS[name] ? name : name?.toLowerCase();

		if (lookup) {
			log.debug(`Resolved emoji :${name}: to ID ${lookup[0]}`);
			const [emojiId, isAnimated] = lookup;
			replacedEmojis += 1;
			return `<${isAnimated ? "a" : ""}:${resolvedName}:${emojiId}>`;
		}

		unknownEmojis += 1;
		log.debug(`Unknown emoji code: :${name}:`);
		return match;
	});

	output = output.replaceAll(/__CUSTOM_EMOJI_(\d+)__/g, (match, index) => {
		const restored = protectedEmojis[Number(index)];
		return restored || match;
	});

	log.debug(`Emoji replace stats: protected=${protectedEmojis.length}, normalized=${normalizedKnownEmojis}, replaced=${replacedEmojis}, unknown=${unknownEmojis}`);
	log.debug(`Final output after emoji processing: ${output}`);
	return output;
}

/**
 * Collect full custom emoji mentions (`<:name:id>` / `<a:name:id>`) that
 * appeared in user messages, so the model may reuse them verbatim.
 */
export function getReusableCustomEmojiMentions(history: HistoryEntry[]): Set<string> {
	const emojis = new Set<string>();

	for (const entry of history) {
		const item = entry.item;
		if (item.kind !== "message" || item.role !== "user")
			continue;

		for (const part of item.content || []) {
			if (part.type !== "text" || typeof part.text !== "string")
				continue;

			for (const match of part.text.matchAll(/<a?:[a-zA-Z0-9_-]+:\d+>/g))
				emojis.add(match[0]);
		}
	}

	return emojis;
}
