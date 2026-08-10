/**
 * MCP-ISSUE-056 — `excludeTests` for the call-graph tools.
 *
 * `excludeTests` shipped for the eight search/bundle tools in MCP-ISSUE-049, but not for the seven
 * that traverse the call graph — which is where it matters most, because interface dispatch fans into
 * test doubles harder than anything else. `get_call_chain` on the `Reply` endpoint resolved
 * `ISender.Send` to six different integration-test classes, all `reason: "interface-dispatch"`, so
 * **6 of 8** returned callees were test doubles and the production path was crowded out of the
 * default `limit` entirely.
 *
 * Filtering happens on the row's file path, matching the semantics the other eight tools already
 * advertise: "drops test-path results entirely". The classifier is
 * `services/indexing/fileFilter.isTestPath` — the same single regex those tools use, so the two
 * families cannot drift apart on what counts as a test.
 */

import { isTestPath } from "../../services/indexing/fileFilter.js";

/**
 * Drop rows living in test files, when the caller asked for it.
 *
 * A row whose path is unknown is KEPT: absence of a path is not evidence of being a test, and
 * silently dropping unattributable rows would trade one invisible bias for another.
 */
export function dropTestRows<T>(
  rows: readonly T[],
  excludeTests: boolean,
  pathOf: (row: T) => string | null | undefined
): T[] {
  if (!excludeTests) return [...rows];
  return rows.filter((row) => {
    const filePath = pathOf(row);
    return !filePath || !isTestPath(filePath);
  });
}
