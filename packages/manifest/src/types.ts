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
  /**
   * Written silently into the agent config when the user supplies no value.
   *
   * Setting this has a consequence beyond documentation: `install-mcp` writes any field that has
   * a `default` (or a `prompt`) into `~/.claude.json`, which *pins* the value. A tuning knob
   * pinned at today's default stops tracking the code's default when that changes. Use
   * {@link codeDefault} to document a fallback without pinning it.
   */
  readonly default?: string;
  /**
   * What the server falls back to when this var is unset — **documentation only, never written
   * to any config.**
   *
   * S-35 added 48 vars the code reads and the manifest had never declared. Almost all are tuning
   * knobs whose value should stay wherever the code puts it, so they carry `codeDefault` and no
   * `default`: they appear in `.env.example` (commented out) and in the README table, and the
   * installer stays silent about them.
   */
  readonly codeDefault?: string;
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
  /**
   * Concrete member names to show for a `prefix` family.
   *
   * The hand-written `.env.example` listed `PG_ENV_DEV` / `PG_ENV_STAGING` / `PG_ENV_PROD`, which
   * is more useful than the wildcard alone — someone reading `PG_ENV_*` still has to guess the
   * suffix convention. Kept so generating the file does not make it worse than what it replaced.
   */
  readonly familyExamples?: readonly string[];
  /**
   * Heading this var is grouped under in the generated `.env.example` and README table.
   *
   * Ordering follows first appearance in the array, so the generated file reads like the
   * hand-written one it replaced rather than like an alphabetical dump.
   */
  readonly section?: string;
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
   * Every tool the server advertises, as `tools/list` reports it.
   *
   * **Generated** — see `src/generated/toolLists.ts`. Until S-36 this was a hand-maintained
   * subset that had already drifted (`codebase-index-local` named 12 of its 43), which is why it
   * is no longer hand-written: `generate:docs` derives it from the committed contract snapshots,
   * and `generate:check` fails when the two disagree.
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
