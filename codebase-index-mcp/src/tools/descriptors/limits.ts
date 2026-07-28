/**
 * The env-derived bounds that appear inside `tools/list` schemas (S-31).
 *
 * Extracting the descriptor table surfaced something the inline array hid: the published
 * schemas are not static. `maximum` on `limit`, `depth` and `maxFiles` is interpolated from
 * environment configuration, so **two deployments with different env can publish different
 * contracts**. The committed snapshots in `contracts/` are therefore snapshots at default
 * values — which is why `contracts:check` boots each server with placeholder env.
 *
 * Passing them in rather than importing them from `index.ts` also keeps the dependency
 * one-way: `index.ts` owns env parsing, the descriptor modules stay data.
 */

export interface DescriptorLimits {
  /** CODEBASE_INDEX_MAX_RESULT_LIMIT — upper bound on every `limit` parameter. */
  readonly maxResultLimit: number;
  /** CODEBASE_INDEX_MAX_DEPTH — upper bound on traversal depth. */
  readonly maxDepth: number;
  /** CODEBASE_INDEX_MAX_FILES_PER_RUN — upper bound on `maxFiles` for an index run. */
  readonly maxFilesPerRun: number;
}
