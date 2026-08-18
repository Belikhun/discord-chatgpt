import type { AIProvider, ConversationItem, ModelInfo, ModelTrait } from "./types";

/** Discord allows at most 25 choices in an autocomplete response. */
export const MODEL_CHOICE_LIMIT = 25;

const providers = new Map<string, AIProvider>();
let defaultProviderId: string | null = null;

export function registerProvider(provider: AIProvider, { isDefault = false }: { isDefault?: boolean } = {}): void {
	providers.set(provider.id, provider);

	if (isDefault || !defaultProviderId)
		defaultProviderId = provider.id;
}

export function getProvider(id: string): AIProvider {
	const provider = providers.get(id);
	if (!provider)
		throw new Error(`Unknown AI provider: ${id}`);

	return provider;
}

/** Every registered provider, in registration order. */
export function listProviders(): AIProvider[] {
	return [...providers.values()];
}

export function getDefaultProvider(): AIProvider {
	if (!defaultProviderId)
		throw new Error("No AI provider registered.");

	return getProvider(defaultProviderId);
}

/**
 * Pick the provider used for models nobody else claims. Throws when the ID is
 * not registered, so a typo in env.json's PROVIDER_DEFAULT fails loudly.
 */
export function setDefaultProvider(id: string): void {
	getProvider(id);
	defaultProviderId = id;
}

/**
 * Resolve the provider serving the given model. Falls back to the default
 * provider when no registered provider lists the model.
 */
export function getProviderForModel(model: string): AIProvider {
	for (const provider of providers.values()) {
		if (provider.models.some((known) => known.id === model))
			return provider;
	}

	return getDefaultProvider();
}

/**
 * Every model offered by every registered provider, in registration order.
 */
export function listModels(): ModelInfo[] {
	const models: ModelInfo[] = [];

	for (const provider of providers.values()) {
		for (const model of provider.models) {
			if (!models.some((known) => known.id === model.id))
				models.push(model);
		}
	}

	return models;
}

/** Catalogue entry for a model, or null when nobody offers it. */
export function findModel(model: string): ModelInfo | null {
	return listModels().find((known) => known.id === model) ?? null;
}

/** Whether any registered provider offers this model. */
export function isKnownModel(model: string): boolean {
	return findModel(model) !== null;
}

/**
 * Metadata for a model, resolved through its owning provider so uncatalogued
 * models still get inferred traits.
 */
export function getModelInfo(model: string): ModelInfo {
	return getProviderForModel(model).getModelInfo(model);
}

/** Whether a model has a capability, resolved through its owning provider. */
export function modelHasTrait(model: string, trait: ModelTrait): boolean {
	return getProviderForModel(model).hasTrait(model, trait);
}

/**
 * Models matching an autocomplete query, capped to what Discord accepts in a
 * single autocomplete response. Prefix matches come first so typing a provider
 * or family name ("gemini", "gpt-5") surfaces the obvious candidates, and the
 * display name is searched too.
 */
export function searchModels(query: string, limit: number = MODEL_CHOICE_LIMIT): ModelInfo[] {
	const needle = query.trim().toLowerCase();
	const models = listModels();

	if (!needle)
		return models.slice(0, limit);

	const matches = (model: ModelInfo, test: (haystack: string) => boolean) =>
		test(model.id.toLowerCase()) || test(model.displayName.toLowerCase());

	const prefixed = models.filter((model) => matches(model, (haystack) => haystack.startsWith(needle)));
	const contained = models.filter((model) => !prefixed.includes(model) && matches(model, (haystack) => haystack.includes(needle)));

	return [...prefixed, ...contained].slice(0, limit);
}

/**
 * Extract plain text fragments from any conversation item, delegating
 * provider-native items to their owning provider.
 */
export function extractItemTexts(item: ConversationItem): string[] {
	if (item.kind === "message") {
		return item.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { type: "text"; text: string }).text);
	}

	if (item.kind === "provider") {
		const provider = providers.get(item.provider);
		if (provider)
			return provider.extractTexts(item);
	}

	return [];
}
