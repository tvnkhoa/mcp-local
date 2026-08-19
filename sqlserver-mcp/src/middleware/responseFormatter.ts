/**
 * This server's response surface.
 *
 * Deliberately thin. The dispatch pipeline in `@mcp/sdk` already reads `profile` from the raw
 * arguments and serializes whatever a handler returns, so a handler returns `ok(payload)` and
 * nothing here has to be called on the happy path.
 *
 * What lives here is the part that is this server's own: the zod fragment its tools share, plus the
 * two predicates below — the "real shaping" this file's original note said to add only when the
 * platform's normalization is not enough. It was not: `find_cross_database_references` returned
 * 295KB and overflowed clients at *every* profile, because the platform's profile handling is
 * null-dropping and minification only, and a payload with no nulls serializes identically at
 * `nano` and `compact`.
 *
 * What is deliberately NOT here is a payload×profile projector. The four candidate cases do not
 * share a shape — one wants to *omit* an array whose rollup already exists, one wants to *cap* an
 * array while keeping its name, one wants to omit two sibling arrays. A projector covering omit,
 * cap and rename would be longer than all of them written by hand, and would push toward
 * renaming a key by profile, which forces every client to branch on profile to find its data.
 * Centralize the threshold; leave the projection at the call site.
 */

import { profileVerbosityRank, type ResponseProfile } from "@mcp/core";
import { z } from "zod";

export type { ResponseProfile };

export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

/** `compact` is the workspace default for read tools: minified JSON, nullish fields dropped. */
export const DEFAULT_PROFILE: ResponseProfile = "compact";

/**
 * The profile a handler shapes against, resolved the way dispatch resolves it.
 *
 * Reproducing dispatch's precedence rather than picking one source is the point. `dispatch.ts`
 * computes the profile from the **raw** arguments before zod runs, then serializes with it; a
 * handler reading only `args.profile` can therefore shape against a different profile than the one
 * its own response is serialized with. That divergence is backlog B-03, and it is reachable today
 * through `deps.defaultProfile` — the test harness sets it, and production will the day anyone
 * passes it to `createServer`.
 *
 * `ctx` is optional so the function stays a pure unit under test.
 */
export function resolveProfile(
  argProfile: ResponseProfile | undefined,
  ctx?: { readonly profile?: ResponseProfile }
): ResponseProfile {
  return argProfile ?? ctx?.profile ?? DEFAULT_PROFILE;
}

/**
 * Does this profile pay for an optional block? An explicit `override` always wins, either way.
 *
 * Ranked rather than enumerated. `profile === "standard" || profile === "verbose"` is a list of the
 * complement, so a fifth rung would silently land on the wrong side of it; `rank >= rank(atLeast)`
 * lands correctly by construction. This is the first call site of `profileVerbosityRank` in the
 * workspace — it has always been documented for exactly this ("Relative payload budget hint, for
 * tools that trim their own output") and never had a consumer.
 */
export function includesDetail(
  profile: ResponseProfile,
  override?: boolean,
  atLeast: ResponseProfile = "standard"
): boolean {
  return override ?? profileVerbosityRank(profile) >= profileVerbosityRank(atLeast);
}
