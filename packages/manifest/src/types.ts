/**
 * The manifest's shapes.
 *
 * These were a JSDoc `@type` comment on one array in `scripts/lib/manifest.mjs`. Writing them
 * out is the point of S-34: the installer, doctor, uninstaller, updater, skill renderer,
 * contract snapshotter and server runner all read this data, and until now nothing checked
 * that a new entry supplied what they read.
 */

/**
 * One environment variable in a server's contract.
 *
 * `required` is deliberately NOT optional. Every field in the manifest already states it, and
 * making the type demand it means adding a server forces the decision at authoring time rather
 * than defaulting to "not required" by omission — the direction of that default is exactly the
 * kind of thing a reader assumes and gets wrong.
 */
export interface EnvField {
  /** The env var name. For a prefix family this is the display form, e.g. `PG_ENV_*`. */
  readonly name: string;
  /** True = the server cannot work without it. Group members express "one of" instead. */
  readonly required: boolean;
  /** True = never echoed by the doctor or the install summary. */
  readonly secret?: boolean;
  /** Written silently when the user supplies no value. */
  readonly default?: string;
  /** Present = the installer asks for this var interactively, using this label. */
  readonly prompt?: string;
  /** "At least one var in this group must be set." */
  readonly group?: string;
  /** Shown near the prompt and in the generated skill's env table. */
  readonly note?: string;
  /**
   * Marks a variable *family* rather than one name: any set var starting with this prefix
   * satisfies the field. Only `PG_ENV_*` uses it, and only inside a group.
   */
  readonly prefix?: string;
}

/** How the installer prepares a server before registering it. */
export interface ServerBuild {
  /** Run `npm install` in the server directory when `node_modules` is absent. */
  readonly install: boolean;
  /** Package scripts run after the build, e.g. `guard:no-llm-runtime`. */
  readonly guards: readonly string[];
}

export interface ServerDescriptor {
  /**
   * The MCP registration key — what a client namespaces tools with
   * (`mcp__<key>__<tool>`), so it is user-visible configuration, not an internal id.
   * Deliberately not always equal to `dir`: see `codebase-index-local` (S-44 owns that).
   */
  readonly key: string;
  readonly displayName: string;
  /** Directory name under the workspace root. */
  readonly dir: string;
  /** Built entry point, relative to `dir`, POSIX-separated. */
  readonly entry: string;
  readonly tagline: string;
  readonly build: ServerBuild;
  /** Command for the live smoke test, or null when the server has none. */
  readonly smokeTest: string | null;
  /** Directory holding the `SKILL.md` template the installer renders. */
  readonly skillSource: string;
  /**
   * Tools listed in the generated skill.
   *
   * A hand-maintained subset, not the full `tools/list` — codebase-index-local names 12 of its
   * 43. S-36 derives this from each server's registry; until then it can drift, and does.
   */
  readonly tools: readonly string[];
  readonly env: readonly EnvField[];
}

/** What {@link import("./env.js").evaluateEnv} reports about a server's environment. */
export interface EnvEvaluation {
  /** Required vars, outside any group, with no value set. */
  readonly missingRequired: readonly string[];
  /** Groups where no member — and no prefix match — has a value. */
  readonly unsatisfiedGroups: readonly string[];
  /**
   * The member names of a group, for building the "one of: a | b | c" message.
   *
   * A function rather than a map because that is what the installer already calls. Preserved
   * shape, not preferred shape.
   */
  groupMembers(group: string): string[];
}
