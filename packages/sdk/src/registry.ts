/**
 * Tool registry.
 *
 * Holds the tools a server exposes, and — critically for migration — can sit in
 * front of a legacy dispatcher. A server mid-migration registers the tools it
 * has converted and delegates the rest to its old switch. Both halves stay
 * live, so tools can move a few at a time instead of all at once.
 */

import type { AnyToolDefinition, ToolDescriptor } from "./toolDefinition.js";
import { toToolDescriptor } from "./toolDefinition.js";

import type { ToolCallResult } from "./responses.js";

/**
 * Adapter onto a pre-existing dispatcher. Lets a server migrate incrementally
 * without ever being half-broken.
 */
export interface LegacyBridge {
  /** Descriptors for tools the legacy dispatcher still owns. */
  listTools(): readonly ToolDescriptor[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface ToolRegistry {
  /** Registered tools first, then any legacy tools, de-duplicated by name. */
  list(): readonly ToolDescriptor[];
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

export function createToolRegistry(
  tools: readonly AnyToolDefinition[],
  options: RegistryOptions = {}
): ToolRegistry {
  const byName = new Map<string, AnyToolDefinition>();

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`createToolRegistry: duplicate tool name "${tool.name}"`);
    }
    byName.set(tool.name, tool);
  }

  const legacy = options.legacy;

  return {
    legacy,

    list() {
      const descriptors: ToolDescriptor[] = [];
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
