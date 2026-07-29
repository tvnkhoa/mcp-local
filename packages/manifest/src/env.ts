/**
 * "Is this server's environment satisfied?" — asked by the installer and the doctor.
 *
 * One implementation on purpose: the two commands must never disagree about whether a config is
 * usable, and they would drift the first time a `group` or `prefix` rule changed on only one side.
 */

import type { EnvEvaluation, ServerDescriptor } from "./types.js";

/**
 * @param presentKeys env var names that currently hold a non-empty value. The caller decides what
 *   "present" means — the installer passes the keys it is about to write, the doctor passes what
 *   is already in the agent config — which is why this takes names rather than reading anything.
 */
export function evaluateEnv(
  server: ServerDescriptor,
  presentKeys: readonly string[]
): EnvEvaluation {
  const present = new Set(presentKeys);

  /**
   * A field is satisfied by its canonical name or by any name it was renamed from.
   *
   * Without this, S-43's rename would make the installer and the doctor report a perfectly working
   * install as unconfigured: the runtime still honours `CH_DB_CONNECTION`, so the server starts and
   * queries fine while the tooling insists there is no connection source. Reporting a false problem
   * on a healthy install is how an operator learns to ignore the tooling.
   */
  const satisfied = (f: (typeof server.env)[number]): boolean => {
    if (present.has(f.name)) return true;
    // A prefix family is satisfied by ANY set var starting with it — `POSTGRES_ENV_DEV` counts for
    // `POSTGRES_ENV_*`, whose literal name is never set by anyone. Aliases of a family are old
    // *prefixes*, so they are matched the same way rather than by equality.
    if (f.prefix !== undefined) {
      const prefixes = [f.prefix, ...(f.deprecatedAliases ?? [])];
      return [...present].some((k) => prefixes.some((p) => k.startsWith(p)));
    }
    return (f.deprecatedAliases ?? []).some((a) => present.has(a));
  };

  // Group members are excluded: a grouped var is never individually required, even when it
  // carries `required: true`. The group's own "one of" check below is what covers it.
  const missingRequired = server.env
    .filter((f) => f.required && !f.group && !satisfied(f))
    .map((f) => f.name);

  const groups = [...new Set(server.env.filter((f) => f.group).map((f) => f.group as string))];

  const groupSatisfied = (g: string): boolean =>
    server.env.some((f) => f.group === g && satisfied(f));

  const unsatisfiedGroups = groups.filter((g) => !groupSatisfied(g));
  const groupMembers = (g: string): string[] =>
    server.env.filter((f) => f.group === g).map((f) => f.name);

  return { missingRequired, unsatisfiedGroups, groupMembers };
}
