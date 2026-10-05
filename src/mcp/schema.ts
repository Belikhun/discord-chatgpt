/**
 * Make an MCP tool's input schema something every provider accepts.
 *
 * MCP servers send ordinary JSON Schema: `$ref` into `$defs`, `oneOf`, optional
 * properties, `additionalProperties` left open. OpenAI takes that as long as
 * the tool is sent non-strict; Gemini takes a narrow dialect and has no `$ref`
 * at all. So references are inlined here (with a depth cap against cycles),
 * keywords neither side reads are dropped, and a missing top-level object
 * shape is filled in.
 */
const DROPPED_KEYS = new Set(["$schema", "$id", "$comment", "$defs", "definitions", "examples", "readOnly", "writeOnly", "deprecated"]);

const MAX_DEPTH = 8;

function resolveRef(ref: string, root: Record<string, any>): Record<string, any> | null {
	const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
	if (!match)
		return null;

	return root[match[1]!]?.[decodeURIComponent(match[2]!)] ?? null;
}

function clean(node: any, root: Record<string, any>, depth: number): any {
	if (Array.isArray(node))
		return node.map((entry) => clean(entry, root, depth));

	if (!node || typeof node !== "object")
		return node;

	if (typeof node.$ref === "string") {
		const target = depth < MAX_DEPTH ? resolveRef(node.$ref, root) : null;
		const { $ref: _ref, ...rest } = node;

		// An unresolvable or too-deep reference becomes "any value", which is
		// looser than the server meant but never a rejected request.
		return target
			? clean({ ...target, ...rest }, root, depth + 1)
			: { ...clean(rest, root, depth), description: rest.description ?? `See ${node.$ref}` };
	}

	const out: Record<string, any> = {};

	for (const [key, value] of Object.entries(node)) {
		if (DROPPED_KEYS.has(key))
			continue;

		if (key === "properties" && value && typeof value === "object") {
			out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, root, depth + 1)]));
			continue;
		}

		out[key] = clean(value, root, depth + 1);
	}

	return out;
}

export function sanitizeToolSchema(schema: unknown): Record<string, any> {
	const root = (schema && typeof schema === "object") ? schema as Record<string, any> : {};
	const cleaned = clean(root, root, 0);

	if (cleaned.type !== "object")
		cleaned.type = "object";

	cleaned.properties ??= {};

	return cleaned;
}

/** A tool name every provider accepts: letters, digits, `_` and `-`, at most 64, not starting with a digit. */
export function sanitizeToolName(prefix: string, name: string): string {
	const joined = `${prefix}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safe = /^[0-9]/.test(joined) ? `_${joined}` : joined;

	return safe.slice(0, 64);
}
