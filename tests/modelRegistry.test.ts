import { beforeAll, describe, expect, test } from "bun:test";
import {
	MODEL_CHOICE_LIMIT,
	findModel,
	getModelInfo,
	getProvider,
	getProviderForModel,
	isKnownModel,
	listModels,
	modelHasTrait,
	registerProvider,
	searchModels,
	setDefaultProvider
} from "../src/ai/registry";
import { ModelTrait, type AIProvider, type ModelInfo } from "../src/ai/types";

/**
 * Two stub providers stand in for the real ones so the registry is tested
 * without constructing API clients.
 */
function stub(id: string, models: { id: string; traits?: ModelTrait[]; displayName?: string }[]): AIProvider {
	const catalogue: ModelInfo[] = models.map((model) => ({
		id: model.id,
		displayName: model.displayName ?? model.id,
		provider: id,
		traits: model.traits ?? []
	}));

	const provider: AIProvider = {
		id,
		models: catalogue,
		getModelInfo: (model) => catalogue.find((entry) => entry.id === model)
			?? { id: model, displayName: model, provider: id, traits: [] },
		hasTrait: (model, trait) => provider.getModelInfo(model).traits.includes(trait),
		respond: async () => ({ items: [], outputText: "", toolCalls: [] }),
		stream: (async function* () { })() as any,
		generateText: async () => "",
		extractTexts: () => []
	};

	return provider;
}

const alpha = stub("registry-alpha", [
	{ id: "alpha-large", displayName: "Alpha Large", traits: [ModelTrait.Thinking, ModelTrait.ViewImage] },
	{ id: "alpha-small" },
	{ id: "shared-model" }
]);

const beta = stub("registry-beta", [
	...Array.from({ length: 30 }, (_, i) => ({ id: `beta-${i}` })),
	{ id: "shared-model" }
]);

beforeAll(() => {
	registerProvider(alpha);
	registerProvider(beta);
});

describe("provider routing", () => {
	test("models resolve to their owning provider", () => {
		expect(getProviderForModel("alpha-large").id).toBe("registry-alpha");
		expect(getProviderForModel("beta-7").id).toBe("registry-beta");
	});

	test("unknown models fall back to the default provider", () => {
		setDefaultProvider("registry-alpha");
		expect(getProviderForModel("model-nobody-owns").id).toBe("registry-alpha");
	});

	test("setDefaultProvider rejects unregistered IDs", () => {
		expect(() => setDefaultProvider("typo-provider")).toThrow(/Unknown AI provider/);
	});

	test("getProvider throws for unknown IDs", () => {
		expect(() => getProvider("nope")).toThrow(/Unknown AI provider/);
	});
});

describe("model listing", () => {
	test("all providers contribute, duplicates collapse", () => {
		const ids = listModels().map((model) => model.id);

		expect(ids).toContain("alpha-large");
		expect(ids).toContain("beta-7");
		expect(ids.filter((id) => id === "shared-model")).toHaveLength(1);
	});

	test("the full list may exceed Discord's choice limit", () => {
		// This is exactly why the model option is autocompleted.
		expect(listModels().length).toBeGreaterThan(MODEL_CHOICE_LIMIT);
	});

	test("isKnownModel reflects the registered catalogues", () => {
		expect(isKnownModel("alpha-small")).toBe(true);
		expect(isKnownModel("not-a-real-model")).toBe(false);
	});

	test("findModel returns the catalogue entry, or null", () => {
		expect(findModel("alpha-large")?.displayName).toBe("Alpha Large");
		expect(findModel("not-a-real-model")).toBe(null);
	});
});

describe("traits", () => {
	test("traits resolve through the owning provider", () => {
		expect(modelHasTrait("alpha-large", ModelTrait.Thinking)).toBe(true);
		expect(modelHasTrait("alpha-large", ModelTrait.ViewImage)).toBe(true);
		expect(modelHasTrait("alpha-large", ModelTrait.GenerateImage)).toBe(false);
		expect(modelHasTrait("alpha-small", ModelTrait.Thinking)).toBe(false);
	});

	test("uncatalogued models still resolve to an info object", () => {
		setDefaultProvider("registry-alpha");
		const info = getModelInfo("model-nobody-owns");

		expect(info.id).toBe("model-nobody-owns");
		expect(info.provider).toBe("registry-alpha");
	});
});

describe("autocomplete search", () => {
	const ids = (query: string) => searchModels(query).map((model) => model.id);

	test("prefix matches come before substring matches", () => {
		const results = ids("alpha");
		expect(results[0]).toBe("alpha-large");
		expect(results).toContain("alpha-small");
	});

	test("search is case insensitive", () => {
		expect(ids("ALPHA-LARGE")).toContain("alpha-large");
	});

	test("display names are searchable too", () => {
		expect(ids("Alpha Large")).toContain("alpha-large");
	});

	test("results never exceed what Discord accepts", () => {
		expect(searchModels("beta").length).toBeLessThanOrEqual(MODEL_CHOICE_LIMIT);
		expect(searchModels("").length).toBeLessThanOrEqual(MODEL_CHOICE_LIMIT);
	});

	test("an unmatched query returns nothing", () => {
		expect(searchModels("zzzz-no-match")).toEqual([]);
	});
});
