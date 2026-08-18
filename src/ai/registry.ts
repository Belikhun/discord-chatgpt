import type { AIProvider, ConversationItem } from "./types";

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

export function getDefaultProvider(): AIProvider {
	if (!defaultProviderId)
		throw new Error("No AI provider registered.");

	return getProvider(defaultProviderId);
}

/**
 * Resolve the provider serving the given model. Falls back to the default
 * provider when no registered provider lists the model.
 */
export function getProviderForModel(model: string): AIProvider {
	for (const provider of providers.values()) {
		if (provider.models.includes(model))
			return provider;
	}

	return getDefaultProvider();
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
