/**
 * Minimal JSON Schema builders.
 *
 * A tool declares two things about its input: a zod schema (runtime validation)
 * and a JSON Schema (what `tools/list` advertises). Keeping them explicit — as
 * every server in this workspace already does by hand — means the advertised
 * contract is exactly what the author wrote, with no generator in between.
 * These builders exist only to remove the boilerplate.
 */

export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: unknown;
}

export interface JsonSchemaObject extends JsonSchemaNode {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
}

export interface ObjectOptions {
  readonly required?: readonly string[];
  /** Default false — tools reject unknown keys unless they opt in. */
  readonly additionalProperties?: boolean;
  readonly description?: string;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = entry;
    }
  }
  return output as T;
}

export const schema = {
  object(
    properties: Readonly<Record<string, JsonSchemaNode>>,
    options: ObjectOptions = {}
  ): JsonSchemaObject {
    return compact({
      type: "object" as const,
      properties,
      required: options.required,
      additionalProperties: options.additionalProperties ?? false,
      description: options.description
    }) as JsonSchemaObject;
  },

  string(description?: string, extra: Omit<JsonSchemaNode, "type" | "description"> = {}): JsonSchemaNode {
    return compact({ type: "string", description, ...extra });
  },

  number(description?: string, extra: Omit<JsonSchemaNode, "type" | "description"> = {}): JsonSchemaNode {
    return compact({ type: "number", description, ...extra });
  },

  integer(description?: string, extra: Omit<JsonSchemaNode, "type" | "description"> = {}): JsonSchemaNode {
    return compact({ type: "integer", description, ...extra });
  },

  boolean(description?: string): JsonSchemaNode {
    return compact({ type: "boolean", description });
  },

  enumOf(
    values: readonly (string | number | boolean)[],
    description?: string
  ): JsonSchemaNode {
    // The advertised type must match the actual member type, or a client
    // validating tools/list strictly rejects the call — or coerces `true` to
    // "true", which the tool's zod schema then refuses.
    const first = values[0];
    const type =
      typeof first === "number" ? "number" : typeof first === "boolean" ? "boolean" : "string";
    return compact({ type, enum: values, description });
  },

  array(items: JsonSchemaNode, description?: string, extra: Pick<JsonSchemaNode, "minItems" | "maxItems"> = {}): JsonSchemaNode {
    return compact({ type: "array", items, description, ...extra });
  },

  /** The standard `profile` argument every read tool accepts. */
  profile(): JsonSchemaNode {
    return {
      type: "string",
      enum: ["nano", "compact", "standard", "verbose"],
      description: "Response verbosity. Defaults to compact."
    };
  }
} as const;

/** An empty object schema — for tools that take no arguments. */
export const EMPTY_OBJECT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {},
  additionalProperties: false
};
