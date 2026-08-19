/**
 * Input-schema parity: what a tool *validates* against vs what it *advertises*.
 *
 * Every tool in this workspace declares its input twice — a zod schema the handler validates with,
 * and a hand-written JSON Schema `tools/list` publishes, usually with `additionalProperties: false`.
 * When the two disagree the same call is valid or invalid depending on how strictly the caller reads
 * the contract, and no existing gate notices: `typecheck` sees two unrelated object literals,
 * `contracts:check` pins the advertised schema against a snapshot of *itself* (so a parameter
 * missing from both stays missing), and `docs:check` reads the advertised side only.
 *
 * Both directions are reported because each means something different. An advertised key with no
 * zod key is a parameter the server will reject as unknown. A zod key with no advertised key is a
 * parameter a conformant client cannot send.
 *
 ## Why this does not use `instanceof`
 *
 * Per ADR 0001 each server owns its own copy of zod outside the npm workspace, so a `ZodObject`
 * built by `sqlserver-mcp` is not an instance of the `ZodObject` class a hoisted package imports —
 * `instanceof` is `false` across the copies even at an identical version.
 *
 * The obvious fix is to inject the caller's namespace, the way `createErrorMapper` takes its error
 * classes. **That was tried and is not sufficient.** A single server's tool table legitimately mixes
 * copies: `health_check` comes from `createHealthCheckTool` in `@mcp/sdk` and carries the hoisted
 * zod, while the other eleven `sqlserver-mcp` tools carry the server's. No single namespace can
 * match both, so injection silently dropped exactly one tool — found by the floor below, which is
 * why it exists.
 *
 * So the walk discriminates structurally, on `_def.typeName`, which is how zod itself tags its
 * nodes and is stable across copies of the same major. The prototype methods (`unwrap`,
 * `innerType`, `removeDefault`) are called on the instance, so they work whichever copy built it.
 * The coupling to a zod internal is deliberate and cheap to detect: if it ever changes, every tool
 * stops being comparable at once and `floor` fails loudly rather than reporting a clean surface.
 */

import assert from "node:assert/strict";

/** A zod node, seen structurally — see the note above on why this is not `instanceof`. */
interface ZodNodeLike {
  readonly _def?: { readonly typeName?: string };
  readonly shape?: Record<string, unknown>;
  innerType?: () => unknown;
  unwrap?: () => unknown;
  removeDefault?: () => unknown;
}

function typeNameOf(node: unknown): string | undefined {
  return (node as ZodNodeLike | null)?._def?.typeName;
}

/** The shape of a tool this check reads. Structural, so every server's definition type fits. */
export interface ParityTool {
  readonly name: string;
  readonly input?: unknown;
  readonly inputSchema?: unknown;
}

export interface SchemaParityOptions {
  /**
   * Minimum number of tools that must be compared. Set it to the server's tool count: a tool that
   * drops out of the comparison (an input built some way `objectShape` cannot unwrap) is a silent
   * hole, and without this it reads as a pass.
   */
  readonly floor: number;
}

export interface SchemaParityResult {
  readonly drift: readonly string[];
  readonly compared: number;
}

/**
 * Unwrap the modifiers a tool schema may be built with to reach the object at the centre.
 *
 * Returns `null` for anything that is not object-shaped — a tool taking no arguments, or an input
 * built from a union. Those are skipped rather than failed, which is what `floor` is for.
 */
function objectShape(schema: unknown): Record<string, unknown> | null {
  let node: unknown = schema;
  for (let depth = 0; depth < 10 && node; depth += 1) {
    const kind = typeNameOf(node);
    const like = node as ZodNodeLike;
    if (kind === "ZodObject") {
      return (like.shape ?? null) as Record<string, unknown> | null;
    }
    // `.unwrap()` exists on Optional and Nullable but NOT on Default, which spells it
    // `.removeDefault()`. The walk this was lifted from cast all three to ZodOptional and called
    // `.unwrap()`, so a `z.object(...).default(...)` input threw `node.unwrap is not a function`.
    // No tool is built that way today, so it never fired.
    if (kind === "ZodEffects" && typeof like.innerType === "function") {
      node = like.innerType();
      continue;
    }
    if ((kind === "ZodOptional" || kind === "ZodNullable") && typeof like.unwrap === "function") {
      node = like.unwrap();
      continue;
    }
    if (kind === "ZodDefault" && typeof like.removeDefault === "function") {
      node = like.removeDefault();
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Collect drift without asserting, for callers that want to report rather than fail.
 *
 * Takes no options: the floor is an assertion concern, and accepting one here only to discard it
 * made every caller invent a number that did nothing.
 */
export function findSchemaParityDrift(tools: readonly ParityTool[]): SchemaParityResult {
  const drift: string[] = [];
  let compared = 0;

  for (const tool of tools) {
    const shape = objectShape(tool.input);
    const advertised = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    if (!shape || !advertised) {
      continue;
    }
    compared += 1;

    const zodKeys = new Set(Object.keys(shape));
    const jsonKeys = new Set(Object.keys(advertised));

    for (const key of zodKeys) {
      if (!jsonKeys.has(key)) {
        drift.push(`${tool.name}: accepts "${key}" but never advertises it`);
      }
    }
    for (const key of jsonKeys) {
      if (!zodKeys.has(key)) {
        drift.push(`${tool.name}: advertises "${key}" but the handler rejects it`);
      }
    }
  }

  return { drift, compared };
}

/** Assert every tool advertises exactly the parameters its zod schema accepts. */
export function assertSchemaParity(
  tools: readonly ParityTool[],
  options: SchemaParityOptions
): void {
  assert.ok(tools.length > 0, "no tools were passed to assertSchemaParity");

  const { drift, compared } = findSchemaParityDrift(tools);

  assert.ok(
    compared >= options.floor,
    compared === 0
      ? `compared 0 of ${String(tools.length)} tools. Every tool was skipped, which means the ` +
        "structural walk no longer recognises a zod node — most likely `_def.typeName` changed " +
        "shape in a zod upgrade. Fix `objectShape`; do not lower the floor."
      : `expected to compare at least ${String(options.floor)} tools, compared ${String(compared)}`
  );
  assert.deepEqual(drift, [], `input-schema drift:\n  ${drift.join("\n  ")}`);
}

/**
 * Assert no tool marks a key required without advertising it.
 *
 * A required key absent from `properties` under `additionalProperties: false` is unsatisfiable:
 * the caller must send it and must not. Needs no zod, so it takes no options.
 */
export function assertRequiredKeysAdvertised(tools: readonly ParityTool[]): void {
  for (const tool of tools) {
    const schema = tool.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
      | undefined;
    if (schema?.additionalProperties !== false) {
      continue;
    }
    for (const key of schema.required ?? []) {
      assert.ok(
        key in (schema.properties ?? {}),
        `${tool.name}: "${key}" is required but not advertised`
      );
    }
  }
}
