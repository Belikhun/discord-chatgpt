import type { AutocompleteInteraction } from "discord.js";
import { log } from "../../logger";
import { searchModels } from "../../ai/registry";
import { ModelTrait, type ModelInfo } from "../../ai/types";

/** Discord rejects choice names longer than this. */
const CHOICE_NAME_MAX_LENGTH = 100;

/** Traits worth advertising in the picker, in the order they are shown. */
const TRAIT_BADGES: readonly [ModelTrait, string][] = [
	[ModelTrait.Thinking, "🧠"],
	[ModelTrait.WebSearch, "🌐"],
	[ModelTrait.GenerateImage, "🎨"],
	[ModelTrait.GenerateAudio, "🎵"],
	[ModelTrait.GenerateVideo, "🎬"],
	[ModelTrait.ViewImage, "👁"],
	[ModelTrait.AnalyzeAudio, "🎧"],
	[ModelTrait.ViewVideo, "📹"]
];

/**
 * Label a model with its display name and a compact run of trait badges, e.g.
 * `gemini-3-pro-image (Nano Banana Pro) 🧠🎨👁`.
 */
function describeModel(model: ModelInfo): string {
	const badges = TRAIT_BADGES
		.filter(([trait]) => model.traits.includes(trait))
		.map(([, badge]) => badge)
		.join("");

	const name = (model.displayName && model.displayName !== model.id)
		? `${model.id} (${model.displayName})`
		: model.id;

	const label = badges ? `${name} ${badges}` : name;
	return (label.length > CHOICE_NAME_MAX_LENGTH) ? model.id.slice(0, CHOICE_NAME_MAX_LENGTH) : label;
}

/**
 * Serve autocomplete suggestions for command options.
 *
 * The `model` option spans every configured provider, which is more entries
 * than Discord allows as static choices, so suggestions are filtered by what
 * the user has typed so far.
 */
export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
	try {
		const focused = interaction.options.getFocused(true);

		if (focused.name !== "model") {
			await interaction.respond([]);
			return;
		}

		await interaction.respond(
			searchModels(focused.value).map((model) => ({
				name: describeModel(model),
				value: model.id
			}))
		);
	} catch (err: any) {
		// Autocomplete responses expire quickly; a failure here is not worth
		// bubbling up to the user.
		log.error(`Không thể trả về gợi ý autocomplete: ${err.message}`);
	}
}
