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

  // Group members are excluded: a grouped var is never individually required, even when it
  // carries `required: true`. The group's own "one of" check below is what covers it.
  const missingRequired = server.env
    .filter((f) => f.required && !f.group && !present.has(f.name))
    .map((f) => f.name);

  const groups = [...new Set(server.env.filter((f) => f.group).map((f) => f.group as string))];

  const groupSatisfied = (g: string): boolean =>
    server.env.some((f) => {
      if (f.group !== g) return false;
      if (present.has(f.name)) return true;
      // A prefix family is satisfied by ANY set var starting with it — `PG_ENV_DEV` counts for
      // `PG_ENV_*`, whose literal name is never set by anyone.
      if (f.prefix !== undefined) return [...present].some((k) => k.startsWith(f.prefix as string));
      return false;
    });

  const unsatisfiedGroups = groups.filter((g) => !groupSatisfied(g));
  const groupMembers = (g: string): string[] =>
    server.env.filter((f) => f.group === g).map((f) => f.name);

  return { missingRequired, unsatisfiedGroups, groupMembers };
}
