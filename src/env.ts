import fs from "node:fs";
import path from "node:path";

/**
 * Credentials and endpoint settings for a single AI provider, keyed by provider
 * ID inside {@link Env.PROVIDERS}. Only `API_KEY` is meaningful for every
 * provider; the rest are optional overrides for gateways, proxies and
 * self-hosted or compatible endpoints.
 */
export interface ProviderConfig {
	API_KEY: string;
	/** Override the provider's API endpoint (proxies, gateways, Azure, …). */
	BASE_URL?: string;
	/** Provider-specific organization ID, when the provider supports one. */
	ORGANIZATION?: string;
	/** Provider-specific project ID, when the provider supports one. */
	PROJECT?: string;
}

/**
 * Typed environment configuration, loaded from `env.json` in the working
 * directory. See `env.example.json` for the reference structure.
 */
export interface Env {
	DISCORD_TOKEN: string;
	APP_ID: string;
	APP_NAME: string;
	ICON: string;

	/**
	 * Per-provider configuration, keyed by provider ID ("openai", and later
	 * "gemini", "anthropic", …). Only the providers listed here are registered,
	 * so this doubles as the enable switch for each one.
	 */
	PROVIDERS: Record<string, ProviderConfig>;

	/**
	 * Provider used for models that no registered provider claims. Defaults to
	 * whichever provider serves `MODEL_DEFAULT`, else the first one configured.
	 */
	PROVIDER_DEFAULT?: string;

	MODEL_DEFAULT: string;
	WAKEUP_KEYWORDS: string[];
	SYSTEM_ROLE_CHAT: string;
	SYSTEM_ROLE_ASSISTANT: string;
	SYSTEM_ROLE_MODEL: Record<string, string>;
	SYSTEM_ROLE_CHANNEL: Record<string, string>;
	SYSTEM_ROLE_SERVER: Record<string, string>;
	SYSTEM_ROLE_SERVER_ASSISTANT: Record<string, string>;
	WELCOME_INSTRUCTION_DEFAULT: string;
	WELCOME_INSTRUCTION_SERVER: Record<string, string>;
	THINKING_MESSAGE: string;
	IMAGE_GENERATING_MESSAGE: string;
	NICKNAME_DEFAULT: string;
}

function loadEnv(): Env {
	// Cast only — deliberately NO default values. A key missing from env.json
	// stays undefined and fails lazily at its first use, exactly like the
	// pre-TypeScript raw JSON import did. (Notably, an omitted API_KEY must stay
	// undefined so a provider SDK can still fall back to its own environment
	// variable, e.g. process.env.OPENAI_API_KEY.)
	const envFile = path.join(process.cwd(), "env.json");
	return JSON.parse(fs.readFileSync(envFile, "utf8")) as Env;
}

export const env = loadEnv();

/**
 * Configuration for one provider, or null when it isn't configured in env.json.
 */
export function getProviderConfig(id: string): ProviderConfig | null {
	return env.PROVIDERS?.[id] ?? null;
}

/**
 * IDs of every provider configured in env.json, in declaration order.
 */
export function listConfiguredProviderIds(): string[] {
	return Object.keys(env.PROVIDERS ?? {});
}
