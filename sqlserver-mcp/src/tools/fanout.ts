/**
 * Running one operation across several catalogs.
 *
 * A SQL Server login is scoped to the instance, so "do this in each of these catalogs" is the shape
 * of most real questions here — which is why `run_read_query` grew `databases[]` first and why
 * metadata tools need the same thing. What is shared is the mechanism: validate the
 * `database`/`databases` pair, run with bounded concurrency keeping request order, capture a
 * per-catalog failure without discarding the rest, and pick between the two response shapes.
 *
 * What is NOT shared is the work itself. Each tool passes a `runOne` closure holding its own
 * guardrails, limits and log events, because a query and a table inventory have nothing in common
 * past the catalog loop.
 *
 * The concurrency loop is deliberately not exported. There is no second kind of item to run it
 * over, and exporting it would invite someone to use it for something that is not a catalog — at
 * which point the pool-count invariant below stops holding.
 */

import { PolicyViolationError, toWireError } from "../middleware/errors.js";
import { MAX_FANOUT_CONCURRENCY } from "../repositories/connectionManager.js";

/**
 * One catalog's slot.
 *
 * A **discriminated union**, not `T & { error?: string }`. Two things fall out of that. A failed
 * slot carries no payload, so `results[0].recordsets` is a type error until the caller narrows on
 * `error === undefined` — which is the check a fan-out caller actually has to write. And the
 * success arm has no `error` key to strip, so the single-catalog path spreads the outcome directly.
 */
export type CatalogOutcome<T> =
  | ({ readonly database: string; readonly error?: undefined; readonly errorCode?: undefined } & T)
  | { readonly database: string; readonly error: string; readonly errorCode: string };

export interface CatalogSelection {
  /** `undefined` means "the catalog the connection string names" and is a legal single-catalog run. */
  readonly catalogs: readonly (string | undefined)[];
  readonly fannedOut: boolean;
}

/**
 * Validate the `database` / `databases` pair and produce the catalog list.
 *
 * **`fannedOut` is `databases !== undefined`, never `catalogs.length > 1`.** `databases: ["OnlyOne"]`
 * returns the fan-out shape, and must keep doing so: a caller that computes its catalog list must
 * not get a different response shape on the day the list happens to have one entry. Returning the
 * flag from here is what makes that rule exist in one place instead of being re-derived per tool.
 */
export function resolveCatalogs(
  input: { readonly database?: string; readonly databases?: readonly string[] },
  maxFanout: number
): CatalogSelection {
  if (input.database !== undefined && input.databases !== undefined) {
    throw new PolicyViolationError(
      "validation_error",
      "Pass either `database` or `databases`, not both."
    );
  }
  if (input.databases !== undefined && input.databases.length > maxFanout) {
    throw new PolicyViolationError(
      "fanout_limit_exceeded",
      `Requested ${String(input.databases.length)} catalogs; SQLSERVER_MAX_FANOUT is ${String(maxFanout)}.`
    );
  }
  return {
    catalogs: input.databases ?? [input.database],
    fannedOut: input.databases !== undefined
  };
}

export interface RunAcrossCatalogsArgs<T extends object> {
  readonly catalogs: readonly (string | undefined)[];
  readonly fannedOut: boolean;
  /** The tool's own work for one catalog. Returns the resolved catalog name with its payload. */
  readonly runOne: (database: string | undefined) => Promise<{ database: string } & T>;
  /**
   * Called for every failure, with the **raw** error.
   *
   * The log gets the driver's own text and the response gets the mapped one. That asymmetry is the
   * point: `toWireError` deliberately withholds detail that can embed a host or a login name, so
   * the log is the only place the real message survives — and it is what an operator needs when a
   * client was told nothing more useful than `upstream_error`.
   */
  readonly onFailure: (database: string | undefined, error: unknown) => void;
  /** Only tests pass this. Production always uses the pool-count invariant below. */
  readonly concurrency?: number;
}

/**
 * Run `runOne` per catalog, bounded, results in request order.
 *
 * When `fannedOut`, a failure fills that catalog's slot and the others still return — a fan-out is
 * not all-or-nothing. When not, the error is rethrown: a single-catalog call has no other slot to
 * report into, and the error IS the result.
 *
 * `MAX_FANOUT_CONCURRENCY` is not merely a sensible default. `ConnectionManager` floors `maxPools`
 * at it so the LRU can never evict a pool an in-flight worker is holding; running at a different
 * concurrency would break that invariant unless the floor moved too. One number, one relationship.
 */
export async function runAcrossCatalogs<T extends object>(
  args: RunAcrossCatalogsArgs<T>
): Promise<CatalogOutcome<T>[]> {
  const { catalogs, fannedOut, runOne, onFailure } = args;
  const concurrency = args.concurrency ?? MAX_FANOUT_CONCURRENCY;

  const attempt = async (database: string | undefined): Promise<CatalogOutcome<T>> => {
    try {
      return (await runOne(database)) as CatalogOutcome<T>;
    } catch (error) {
      onFailure(database, error);
      if (!fannedOut) {
        throw error;
      }
      // `toWireError` rather than a bespoke classifier: it is this server's single answer to what a
      // client may see, so a slot says exactly what the top-level envelope would have said had the
      // same call been made against one catalog. It also preserves the real code of a
      // PolicyViolationError from `resolve()` — `database_not_allowed` — which a raw `.message`
      // threw away.
      const wire = toWireError(error);
      return { database: database ?? "(default)", error: wire.message, errorCode: wire.code };
    }
  };

  const results = new Array<CatalogOutcome<T>>(catalogs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, catalogs.length) }, async () => {
      for (let index = cursor++; index < catalogs.length; index = cursor++) {
        results[index] = await attempt(catalogs[index]);
      }
    })
  );
  return results;
}

/** The rolled-up form: what a fan-out call gets back. */
export interface CatalogRollup<T extends object> {
  readonly catalogCount: number;
  readonly failureCount: number;
  readonly results: readonly CatalogOutcome<T>[];
}

/**
 * Flat when single, rolled up when fanned out — the one place that branch is written.
 *
 * Three copies of `fannedOut ? {…} : {…}` is how one of them ends up spelling it `databaseCount`.
 *
 * The return is a union rather than `B & Record<string, unknown>` so a caller reading
 * `payload.failureCount` has to establish it fanned out first. A looser type here made the tests
 * reach for a cast, which is the same signal one call site down.
 */
export function catalogPayload<T extends object, B extends object>(
  base: B,
  outcomes: readonly CatalogOutcome<T>[],
  fannedOut: boolean
): (B & CatalogOutcome<T>) | (B & CatalogRollup<T>) {
  if (!fannedOut) {
    return { ...base, ...(outcomes[0] as CatalogOutcome<T>) };
  }
  return {
    ...base,
    catalogCount: outcomes.length,
    failureCount: outcomes.filter((outcome) => outcome.error !== undefined).length,
    results: outcomes
  };
}
