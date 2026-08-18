import { registerProvider } from "./registry";
import { openAIProvider } from "./providers/openai";

// Register all available providers. Future providers (Gemini, Claude, …)
// are added here and picked up automatically via getProviderForModel().
registerProvider(openAIProvider, { isDefault: true });

export * from "./types";
export * from "./registry";
export { openAIProvider };
