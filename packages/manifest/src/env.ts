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

/**
 * "Do the configured VALUES have the right shape?" — the check `evaluateEnv` deliberately does not make.
 *
 * `evaluateEnv` answers whether the required keys are present. That passed for a config whose keys were
 * all correct and whose values were wrong, which is the failure that prompted this: an install narrowed
 * `CODEBASE_INDEX_ALLOWED_ROOTS`, turned the docs lane off, and dropped four keys, and every doctor check
 * still reported healthy. Key presence is necessary and was being treated as sufficient.
 *
 * Two constraints shape what this can check:
 *
 * 1. **It must never see a value it then reports.** Findings name the VARIABLE and the expected shape,
 *    never the content, so a mistyped secret produces "not a number", not the secret. `secret` fields are
 *    still shape-checked — a boolean flag is not sensitive because it sits next to a token.
 * 2. **It cannot know intent.** A valid-but-wrong allowlist root is indistinguishable from a correct one
 *    without a known-good snapshot, so that class of damage is out of scope here and stays in the
 *    "still open" column. What IS detectable: a value the server will silently ignore.
 *
 * Silent fallback is the real cost being addressed. `booleanFromEnv("X", true)` given `"yes"` returns the
 * fallback, so a flag an operator believes they set is simply off, with nothing logged.
 */
export function evaluateEnvValues(
  server: ServerDescriptor,
  values: Readonly<Record<string, string | undefined>>
): { readonly name: string; readonly problem: string }[] {
  const findings: { name: string; problem: string }[] = [];

  for (const field of server.env) {
    // A prefix family has no single name to look up; its members are validated by whatever declares them.
    if (field.prefix !== undefined) continue;

    const raw = values[field.name] ?? readAliased(field, values);
    if (raw === undefined || raw.trim() === "") continue; // absence is `evaluateEnv`'s question, not this one.

    const kind = field.kind ?? inferKind(field);
    if (kind === undefined || kind === "string") continue;

    const value = raw.trim();
    switch (kind) {
      case "boolean":
        // Matches what the servers' own `booleanFromEnv` accepts. Anything else takes the fallback
        // silently, which is exactly the case worth reporting.
        if (!["true", "false", "1", "0", "yes", "no"].includes(value.toLowerCase())) {
          findings.push({ name: field.name, problem: "expected a boolean (true/false); the server will ignore it and use its default" });
        }
        break;
      case "number":
        if (!/^-?\d+(\.\d+)?$/.test(value)) {
          findings.push({ name: field.name, problem: "expected a number; the server will ignore it and use its default" });
        }
        break;
      case "enum": {
        const allowed = field.enumValues ?? [];
        if (allowed.length > 0 && !allowed.some((a) => a.toLowerCase() === value.toLowerCase())) {
          findings.push({ name: field.name, problem: `expected one of: ${allowed.join(" | ")}` });
        }
        break;
      }
      case "path":
      case "path-list": {
        // Only the SHAPE is checkable here. Whether the path exists is a filesystem question, and this
        // package has no filesystem access by design (it is imported by the generators too) — the doctor
        // does that half, where it can report it as a warning rather than a contract violation.
        const parts = kind === "path-list" ? value.split(",") : [value];
        const empty = parts.filter((p) => p.trim() === "").length;
        if (empty > 0) {
          findings.push({ name: field.name, problem: "contains an empty entry — a stray comma silently shortens the list" });
        }
        const relative = parts.filter((p) => p.trim() !== "" && !isAbsolutePathish(p.trim()));
        if (relative.length > 0) {
          findings.push({ name: field.name, problem: `${String(relative.length)} entr${relative.length === 1 ? "y is" : "ies are"} not an absolute path` });
        }
        break;
      }
    }
  }

  return findings;
}

function readAliased(
  field: ServerDescriptor["env"][number],
  values: Readonly<Record<string, string | undefined>>
): string | undefined {
  for (const alias of field.deprecatedAliases ?? []) {
    const v = values[alias];
    if (v !== undefined && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * Infer the shape from the declared default, so annotating 95 fields by hand is not the price of
 * admission. `"true"` can only be a boolean; `"5000"` can only be a number.
 *
 * Returns undefined when the default says nothing — a field with no default, or one whose default is
 * ordinary text. Silence is correct there: guessing would produce false findings, and a doctor that cries
 * wolf is worse than one that checks less.
 */
function inferKind(field: ServerDescriptor["env"][number]): "boolean" | "number" | undefined {
  const declared = field.default ?? field.codeDefault;
  if (declared === undefined) return undefined;
  const d = declared.trim().toLowerCase();
  if (d === "true" || d === "false") return "boolean";
  if (/^-?\d+(\.\d+)?$/.test(d)) return "number";
  return undefined;
}

/** Absolute on either platform: `/srv/x`, `D:\x`, `D:/x`, or a UNC share. */
function isAbsolutePathish(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\/]/.test(p) || p.startsWith("\\\\");
}
