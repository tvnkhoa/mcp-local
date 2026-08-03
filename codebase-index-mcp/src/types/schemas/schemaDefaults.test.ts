import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import * as schemas from "./toolSchemas.js";
import { responseProfileSchema } from "./shared.js";

/**
 * Every declared default actually applies (backlog B-03).
 *
 * `listRepositoriesSchema` declared `responseProfileSchema.default("compact").optional()`.
 * `.optional()` wraps the default and short-circuits an absent value **before** it applies, so
 * `parse({})` returned `{}`, the handler's own `?? "standard"` took over, and the tool answered at
 * a profile it never advertised. Nothing could catch it: `tools/list` carries a separate
 * hand-written JSON Schema, and for that payload `compact` and `standard` serialize to the same
 * 220 bytes, so neither `contracts:check` nor a response replay could see the difference.
 *
 * The general rule these tests enforce: **a zod field may not be both `.default()` and
 * `.optional()`**, in either order. `.optional().default(x)` happens to work, but pinning only the
 * broken order would let the confusing one spread. If a field is genuinely optional with no
 * default, it simply has no default to check.
 */

/** Walk a schema (through `.strict()`, `.refine()`, wrappers) down to its object shape. */
function shapeOf(schema: unknown): Record<string, z.ZodTypeAny> | null {
  let current = schema as { _def?: { schema?: unknown; typeName?: string; shape?: () => unknown } };
  for (let hops = 0; hops < 10 && current?._def; hops += 1) {
    if (typeof current._def.shape === "function") {
      return current._def.shape() as Record<string, z.ZodTypeAny>;
    }
    if (current._def.schema) {
      current = current._def.schema as typeof current;
      continue;
    }
    return null;
  }
  return null;
}

/** Every exported object schema, with the factory ones instantiated. */
function allSchemas(): [string, z.ZodTypeAny][] {
  return Object.entries(schemas).flatMap(([name, value]) => {
    if (typeof value === "function") {
      // The `(MAX_RESULT_LIMIT) => schema` factories.
      try { return [[name, (value as (n: number) => z.ZodTypeAny)(200)]]; } catch { return []; }
    }
    if (value && typeof value === "object" && "_def" in value) {
      return [[name, value as z.ZodTypeAny]];
    }
    return [];
  });
}

test("no field is both optional and defaulted", () => {
  const offenders: string[] = [];
  for (const [schemaName, schema] of allSchemas()) {
    const shape = shapeOf(schema);
    if (!shape) continue;
    for (const [field, def] of Object.entries(shape)) {
      const outer = (def as { _def?: { typeName?: string } })._def?.typeName;
      const inner = (def as { _def?: { innerType?: { _def?: { typeName?: string } } } })._def?.innerType?._def?.typeName;
      const both =
        (outer === "ZodOptional" && inner === "ZodDefault") ||
        (outer === "ZodDefault" && inner === "ZodOptional");
      if (both) offenders.push(`${schemaName}.${field} (${String(outer)}<${String(inner)}>)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a field declared both .default() and .optional() — the default may never apply:\n  ${offenders.join("\n  ")}`
  );
});

test("every schema with a profile field resolves it on an empty-ish parse", () => {
  const checked: string[] = [];
  for (const [schemaName, schema] of allSchemas()) {
    const shape = shapeOf(schema);
    if (!shape?.profile) continue;

    // Supply the required fields generically so the parse reaches the profile default.
    const input: Record<string, unknown> = {};
    for (const [field, def] of Object.entries(shape)) {
      if (field === "profile") continue;
      if (def.isOptional()) continue;
      const typeName = (def as { _def?: { typeName?: string } })._def?.typeName;
      if (typeName === "ZodString") input[field] = "x";
      else if (typeName === "ZodNumber") input[field] = 1;
      else if (typeName === "ZodBoolean") input[field] = false;
      else if (typeName === "ZodArray") input[field] = ["x"];
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) continue; // cross-field .refine() rules we cannot satisfy generically
    const value = (parsed.data as { profile?: unknown }).profile;
    assert.notEqual(
      value, undefined,
      `${schemaName}: profile is undefined after parsing — its declared default did not apply`
    );
    assert.ok(responseProfileSchema.safeParse(value).success, `${schemaName}: profile is not a valid profile`);
    checked.push(schemaName);
  }
  assert.ok(checked.length >= 10, `expected to check many schemas, only reached: ${checked.join(", ")}`);
});

test("list_repositories specifically answers at the profile it advertises", () => {
  // The exact regression. Its description tells callers to "omit for full metadata", and the
  // schema says compact — those disagree in wording but the schema is what the server must honour.
  const parsed = schemas.listRepositoriesSchema.parse({});
  assert.equal(parsed.profile, "compact");
});
