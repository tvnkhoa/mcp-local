/**
 * Response profiles.
 *
 * Shared vocabulary for how verbose a tool response is. `compact` is the
 * platform default for read tools; only `verbose` is pretty-printed.
 */

export const RESPONSE_PROFILES = ["nano", "compact", "standard", "verbose"] as const;
export type ResponseProfile = (typeof RESPONSE_PROFILES)[number];

export const DEFAULT_RESPONSE_PROFILE: ResponseProfile = "compact";

export function isResponseProfile(value: unknown): value is ResponseProfile {
  return typeof value === "string" && (RESPONSE_PROFILES as readonly string[]).includes(value);
}

export function parseResponseProfile(
  value: unknown,
  fallback: ResponseProfile = DEFAULT_RESPONSE_PROFILE
): ResponseProfile {
  return isResponseProfile(value) ? value : fallback;
}

/** Only `verbose` is pretty-printed; everything else is minified. */
export function shouldPrettyPrint(profile: ResponseProfile): boolean {
  return profile === "verbose";
}

/**
 * Only `nano` and `compact` drop null/undefined fields.
 *
 * `standard` keeps them: it is the profile you pick when you want the full
 * response shape including explicit nulls, without paying for pretty-printing.
 * All four servers implement exactly this rule (`compact || nano`), so it is the
 * behaviour shared code has to match — an earlier `profile !== "verbose"` here
 * silently stripped nulls on `standard` too.
 */
export function shouldDropNullish(profile: ResponseProfile): boolean {
  return profile === "nano" || profile === "compact";
}

/** Relative payload budget hint, for tools that trim their own output. */
export function profileVerbosityRank(profile: ResponseProfile): number {
  switch (profile) {
    case "nano":
      return 0;
    case "compact":
      return 1;
    case "standard":
      return 2;
    case "verbose":
      return 3;
  }
}
