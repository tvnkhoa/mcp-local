/**
 * The `tools/list` descriptors still owned by the legacy `switch` — 14 of the original 43.
 *
 * Order is preserved for reviewability, not correctness: `contracts:check` sorts by name before
 * diffing, and the SDK registry lists migrated tools ahead of legacy ones — so this order can
 * change as S-32 proceeds without the contract moving.
 *
 * Shrinks batch by batch through S-32 and disappears at S-33. Read/metadata, search and
 * graph/impact (29 tools) have moved to `tools/`; their descriptors now live inside those tool
 * definitions. Only indexing/watch and refactor are left.
 */

import type { ListedToolDescriptor } from "@mcp/sdk";

import type { DescriptorLimits } from "./limits.js";
import { indexingWatchDescriptors } from "./indexingWatch.js";
import { refactorDescriptors } from "./refactor.js";

export type { DescriptorLimits } from "./limits.js";

const DECLARATION_ORDER: readonly string[] = [
  "index_repository",
  "find_field_accesses",
  "watch_repo",
  "get_symbol_blame",
  "change_impact",
  "get_feature_bundle",
  "rename_assist",
  "refactor_replace_preview",
  "refactor_replace_apply",
  "refactor_replace_rollback",
  "refactor_symbol_migration",
  "change_value_representation",
  "get_persistence_mapping",
  "get_value_contract_impact",
];

/**
 * Every legacy descriptor, restored to the order `index.ts` used before the split.
 *
 * The lookup is deliberate rather than a plain concat: it fails loudly if a batch drops or
 * renames a tool, which during S-32 is the difference between a caught mistake and a tool
 * silently vanishing from `tools/list`.
 */
export function legacyToolDescriptors(limits: DescriptorLimits): readonly ListedToolDescriptor[] {
  const all = [
    ...indexingWatchDescriptors(limits),
    ...refactorDescriptors(limits)
  ];
  return DECLARATION_ORDER.map((name) => {
    const found = all.find((descriptor) => descriptor.name === name);
    if (found === undefined) {
      throw new Error(`legacyToolDescriptors: no descriptor for "${name}"`);
    }
    return found;
  });
}
