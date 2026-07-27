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

/** Every profile except `verbose` drops null/undefined fields. */
export function shouldDropNullish(profile: ResponseProfile): boolean {
  return profile !== "verbose";
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
