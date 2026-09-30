/**
 * One in-process mutex PER ENVIRONMENT, shared by every lane that changes a database.
 *
 * `write_apply`, `write_rollback` and `migration_apply` all take it, so on one database a data
 * write never interleaves with another data write, a rollback or a schema migration. Different
 * environments still proceed in parallel: a long apply on staging must not block an unrelated
 * write on dev.
 *
 * It orders this process only. Another server process, or anyone else connected to the same
 * database, is not stopped by it. Cross-process exclusion is the job of a database-side lock
 * (the DDL lane's advisory lock), not of this.
 *
 * Not re-entrant: a function running under `runExclusive(env, …)` that calls
 * `runExclusive(env, …)` again waits for itself forever. No caller nests today.
 */
const mutexes = new Map<string, Promise<unknown>>();

export function runExclusive<T>(envKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(envKey) ?? Promise.resolve();
  // `fn` on both branches: a failed predecessor releases the lock just like a successful one.
  const run = prev.then(fn, fn);
  mutexes.set(
    envKey,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}
