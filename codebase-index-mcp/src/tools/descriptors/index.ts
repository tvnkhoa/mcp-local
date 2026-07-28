/**
 * The 43 legacy `tools/list` descriptors, in the order `index.ts` declared them (S-31).
 *
 * Order is preserved for reviewability, not correctness: `contracts:check` sorts by name before
 * diffing, and the SDK registry lists migrated tools ahead of legacy ones — so this order can
 * change as S-32 proceeds without the contract moving.
 *
 * This barrel shrinks batch by batch through S-32 and disappears at S-33.
 */

import type { ListedToolDescriptor } from "@mcp/sdk";

import type { DescriptorLimits } from "./limits.js";
import { readMetadataDescriptors } from "./readMetadata.js";
import { searchDescriptors } from "./search.js";
import { graphImpactDescriptors } from "./graphImpact.js";
import { indexingWatchDescriptors } from "./indexingWatch.js";
import { refactorDescriptors } from "./refactor.js";

export type { DescriptorLimits } from "./limits.js";

const DECLARATION_ORDER: readonly string[] = [
  "health_check",
  "index_repository",
  "get_dependency_graph",
  "get_call_chain",
  "find_field_accesses",
  "list_repositories",
  "search_symbols",
  "search_literals",
  "search_regex",
  "get_file_context",
  "get_symbol_detail",
  "find_impact_files",
  "get_change_context",
  "get_file_summary",
  "watch_repo",
  "find_symbol_at_line",
  "get_symbol_context_pack",
  "query_docs",
  "dead_code_scan",
  "detect_circular_dependencies",
  "get_cross_repo_impact",
  "find_package_consumers",
  "get_symbol_blame",
  "get_symbol_source",
  "link_tests_to_source",
  "detect_changes",
  "change_impact",
  "get_feature_bundle",
  "orient",
  "get_folder_summary",
  "find_entry_points",
  "find_implementations",
  "route_map",
  "query_graph",
  "rename_assist",
  "refactor_replace_preview",
  "refactor_replace_apply",
  "refactor_replace_rollback",
  "refactor_symbol_migration",
  "change_value_representation",
  "get_persistence_mapping",
  "get_value_contract_impact",
  "trace_execution_flow",
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
    ...readMetadataDescriptors(limits),
    ...searchDescriptors(limits),
    ...graphImpactDescriptors(limits),
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
