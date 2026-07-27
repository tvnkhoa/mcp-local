/**
 * Tool-contract snapshots.
 *
 * The migration plan's primary regression net (step S-06): capture the public
 * tool surface as deterministic JSON and diff live output against it. A
 * refactor that changes a name, a schema, a description, or an annotation
 * becomes a test failure instead of a discovery.
 *
 * This module only builds and compares snapshots from ToolDefinitions — it does
 * not spawn servers. Capturing a snapshot from a *running* server is the CLI's
 * job and belongs with the server migration, not the foundation.
 */

import { stableStringify } from "@mcp/core";
import type { AnyToolDefinition, ToolDescriptor } from "@mcp/sdk";
import { toToolDescriptor } from "@mcp/sdk";

export interface ContractSnapshot {
  readonly server: string;
  readonly toolCount: number;
  /** Descriptors sorted by name so the snapshot is order-independent. */
  readonly tools: readonly ToolDescriptor[];
}

export function snapshotTools(server: string, tools: readonly AnyToolDefinition[]): ContractSnapshot {
  const descriptors = tools
    .map(toToolDescriptor)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { server, toolCount: descriptors.length, tools: descriptors };
}

/** Deterministic serialization suitable for committing to `contracts/`. */
export function serializeSnapshot(snapshot: ContractSnapshot): string {
  return `${stableStringify(snapshot, true)}\n`;
}

export interface ContractDifference {
  readonly tool: string;
  readonly kind: "added" | "removed" | "changed";
  readonly detail: string;
}

/** Compare two snapshots. An empty array means the contract is unchanged. */
export function diffSnapshots(
  expected: ContractSnapshot,
  actual: ContractSnapshot
): readonly ContractDifference[] {
  const differences: ContractDifference[] = [];

  const expectedByName = new Map(expected.tools.map((tool) => [tool.name, tool]));
  const actualByName = new Map(actual.tools.map((tool) => [tool.name, tool]));

  for (const [name, expectedTool] of expectedByName) {
    const actualTool = actualByName.get(name);
    if (actualTool === undefined) {
      differences.push({ tool: name, kind: "removed", detail: "tool is no longer advertised" });
      continue;
    }
    const before = stableStringify(expectedTool);
    const after = stableStringify(actualTool);
    if (before !== after) {
      differences.push({
        tool: name,
        kind: "changed",
        detail: describeChange(expectedTool, actualTool)
      });
    }
  }

  for (const name of actualByName.keys()) {
    if (!expectedByName.has(name)) {
      differences.push({ tool: name, kind: "added", detail: "tool is newly advertised" });
    }
  }

  return differences;
}

function describeChange(expected: ToolDescriptor, actual: ToolDescriptor): string {
  const changed: string[] = [];
  if (expected.description !== actual.description) {
    changed.push("description");
  }
  if (expected.title !== actual.title) {
    changed.push("title");
  }
  if (stableStringify(expected.inputSchema) !== stableStringify(actual.inputSchema)) {
    changed.push("inputSchema");
  }
  if (stableStringify(expected.annotations) !== stableStringify(actual.annotations)) {
    changed.push("annotations");
  }
  return changed.length === 0 ? "unspecified change" : `${changed.join(", ")} changed`;
}

/** Human-readable report for a CI failure message. */
export function formatDifferences(differences: readonly ContractDifference[]): string {
  if (differences.length === 0) {
    return "contract unchanged";
  }
  return differences
    .map((difference) => `  [${difference.kind}] ${difference.tool}: ${difference.detail}`)
    .join("\n");
}
