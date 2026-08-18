import fs from "node:fs";
import path from "node:path";

/**
 * Typed environment configuration, loaded from `env.json` in the working
 * directory. See `env.example.json` for the reference structure.
 */
export interface Env {
	OPENAI_API_KEY: string;
	DISCORD_TOKEN: string;
	APP_ID: string;
	GUILD_ID: string;
	APP_NAME: string;
	ICON: string;
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
	// pre-TypeScript raw JSON import did. (Notably, a missing OPENAI_API_KEY
	// must stay undefined so the OpenAI SDK can fall back to the
	// process.env.OPENAI_API_KEY variable.)
	const envFile = path.join(process.cwd(), "env.json");
	return JSON.parse(fs.readFileSync(envFile, "utf8")) as Env;
}

export const env = loadEnv();
