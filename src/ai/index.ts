import { env, getProviderConfig, listConfiguredProviderIds, type ProviderConfig } from "../env";
import { scope } from "../logger";
import { listProviders, registerProvider, setDefaultProvider } from "./registry";
import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";
import type { AIProvider } from "./types";

const log = scope("ai");

/**
 * Every provider implementation, keyed by the ID used in env.json `PROVIDERS`.
 * Supporting a new provider means adding its factory here — the rest of the
 * wiring (registration, model routing, `/model` choices) follows from config.
 */
const factories: Record<string, (config: ProviderConfig) => AIProvider> = {
	openai: (config) => new OpenAIProvider(config),
	gemini: (config) => new GeminiProvider(config)
};

//* ===========================================================
//*  Register the configured providers
//* -----------------------------------------------------------
//*  Only providers present in env.json are constructed, so the
//*  config doubles as the enable switch for each of them.
//* ===========================================================

for (const id of listConfiguredProviderIds()) {
	const factory = factories[id];

	if (!factory) {
		log.warn(`Bỏ qua provider chưa được hỗ trợ trong env.json: ${id}`);
		continue;
	}

	registerProvider(factory(getProviderConfig(id)!));
	log.debug(`Đã khởi tạo AI provider: ${id}`);
}

if (listProviders().length === 0)
	throw new Error("Không có AI provider nào được cấu hình. Hãy khai báo ít nhất một provider trong PROVIDERS của env.json.");

// Default provider: the explicit choice, else whoever serves MODEL_DEFAULT,
// else the first one configured (already set during registration).
if (env.PROVIDER_DEFAULT) {
	setDefaultProvider(env.PROVIDER_DEFAULT);
} else {
	const owner = listProviders().find((provider) => provider.models.some((model) => model.id === env.MODEL_DEFAULT));

	if (owner)
		setDefaultProvider(owner.id);
}

export * from "./types";
export * from "./registry";
export { OpenAIProvider, GeminiProvider };
