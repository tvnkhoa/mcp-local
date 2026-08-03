/**
 * Tool registry.
 *
 * Holds the tools a server exposes, and — critically for migration — can sit in
 * front of a legacy dispatcher. A server mid-migration registers the tools it
 * has converted and delegates the rest to its old switch. Both halves stay
 * live, so tools can move a few at a time instead of all at once.
 */

import type { Entry } from "./collect.js";
import { flattenEntries, indexByName } from "./collect.js";
import type { AnyToolDefinition, ToolDescriptor } from "./toolDefinition.js";
import { toToolDescriptor } from "./toolDefinition.js";

import type { ToolCallResult } from "./responses.js";

/**
 * A descriptor as it goes out over `tools/list`.
 *
 * `annotations` is optional here, and that is the whole point. `defineTool` requires them, so
 * every *migrated* tool has them — but a legacy tool predates the requirement, and its
 * descriptor is whatever the server has been publishing. Demanding annotations from the
 * un-migrated side would force a server to add a key to every tool at the moment it installs
 * the bridge, which is a public contract change disguised as a refactor. codebase-index-mcp
 * publishes 43 tools with no annotations at all; its committed contract snapshot has none.
 *
 * So the bridge passes legacy descriptors through untouched, and annotations appear per tool
 * exactly when that tool migrates — a visible, intentional, one-tool-at-a-time contract edit.
 */
export type ListedToolDescriptor = Omit<ToolDescriptor, "annotations"> & {
  readonly annotations?: ToolDescriptor["annotations"];
};

/**
 * Adapter onto a pre-existing dispatcher. Lets a server migrate incrementally
 * without ever being half-broken.
 */
export interface LegacyBridge {
  /** Descriptors for tools the legacy dispatcher still owns, exactly as it publishes them. */
  listTools(): readonly ListedToolDescriptor[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface ToolRegistry {
  /** Registered tools first, then any legacy tools, de-duplicated by name. */
  list(): readonly ListedToolDescriptor[];
  get(name: string): AnyToolDefinition | undefined;
  has(name: string): boolean;
  names(): readonly string[];
  readonly legacy: LegacyBridge | undefined;
  /** Counts for health output and migration progress reporting. */
  stats(): { readonly registered: number; readonly legacy: number };
}

export interface RegistryOptions {
  readonly legacy?: LegacyBridge;
}

/**
 * Assemble a server's tool table from its groups.
 *
 * The counterpart to `registerPrompt` / `registerResource`, and the same
 * entries-may-be-groups shape: a server's `buildTools()` passes the five lists it
 * builds instead of spreading them into one literal. Duplicate names fail here,
 * at construction, rather than at `createToolRegistry` a stack frame later — the
 * point being that the failure names the builder the author was calling.
 *
 * Returns the frozen table, which is what `createServer` takes. The registry
 * itself stays an internal concern of the runtime.
 */
export function registerTool(tools: readonly Entry<AnyToolDefinition>[]): readonly AnyToolDefinition[] {
  const flat = flattenEntries(tools);
  indexByName("registerTool", "tool", flat);
  return Object.freeze(flat);
}

export function createToolRegistry(
  tools: readonly AnyToolDefinition[],
  options: RegistryOptions = {}
): ToolRegistry {
  const byName = indexByName("createToolRegistry", "tool", tools);

  const legacy = options.legacy;

  return {
    legacy,

    list() {
      const descriptors: ListedToolDescriptor[] = [];
      for (const tool of byName.values()) {
        descriptors.push(toToolDescriptor(tool));
      }
      if (legacy !== undefined) {
        for (const descriptor of legacy.listTools()) {
          // A migrated tool wins over its legacy twin.
          if (!byName.has(descriptor.name)) {
            descriptors.push(descriptor);
          }
        }
      }
      return descriptors;
    },

    get: (name) => byName.get(name),

    has: (name) => byName.has(name) || (legacy?.has(name) ?? false),

    names() {
      const names = [...byName.keys()];
      if (legacy !== undefined) {
        for (const descriptor of legacy.listTools()) {
          if (!byName.has(descriptor.name)) {
            names.push(descriptor.name);
          }
        }
      }
      return names;
    },

    stats: () => ({
      registered: byName.size,
      legacy: legacy === undefined ? 0 : legacy.listTools().filter((d) => !byName.has(d.name)).length
    })
  };
}
