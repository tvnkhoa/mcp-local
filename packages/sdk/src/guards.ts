/**
 * Guards — composable pre-execution checks.
 *
 * A guard runs after input validation and before the handler. It is the single
 * declared place where a tool says "I am gated by X", which is what makes a
 * security review of a server tractable: read the guard list, not the body.
 *
 * Guards that need a capability (an approval service, an allowlist) are built
 * by the *server* from `@mcp/shared` and passed in. The SDK stays free of the
 * capability tier so the dependency direction holds.
 */

import type { PlatformError, Result } from "@mcp/core";
import { err, ok, policyViolation, toPlatformError } from "@mcp/core";

import type { Guard, GuardContext } from "./toolDefinition.js";

export function defineGuard(
  name: string,
  check: (context: GuardContext) => Result<void, PlatformError> | Promise<Result<void, PlatformError>>
): Guard {
  if (name.trim() === "") {
    throw new Error("defineGuard: name must be a non-empty string");
  }
  return { name, check };
}

/**
 * Refuse the call unless a feature flag is on. The platform's write-gating
 * pattern: `<SERVER>_WRITE_ENABLED`, default false.
 */
export function featureFlagGuard(name: string, isEnabled: () => boolean, message: string): Guard {
  return defineGuard(name, () =>
    isEnabled() ? ok(undefined) : err(policyViolation(message, { guard: name }))
  );
}

/**
 * Refuse the call when a named environment is read-only, regardless of any
 * other flag. Used for hard invariants such as "prod is never writable".
 */
export function immutableTargetGuard(
  name: string,
  resolveTarget: (input: unknown) => string | undefined,
  immutableTargets: readonly string[],
  message: string
): Guard {
  const blocked = new Set(immutableTargets.map((entry) => entry.toLowerCase()));
  return defineGuard(name, (context) => {
    const target = resolveTarget(context.input);
    if (target !== undefined && blocked.has(target.toLowerCase())) {
      return err(policyViolation(message, { guard: name, target }));
    }
    return ok(undefined);
  });
}

/** Run guards in declaration order, stopping at the first refusal. */
export async function runGuards(
  guards: readonly Guard[],
  context: GuardContext
): Promise<Result<void, PlatformError>> {
  for (const guard of guards) {
    try {
      const outcome = await guard.check(context);
      if (!outcome.ok) {
        return outcome;
      }
    } catch (cause) {
      return err(toPlatformError(cause, `Guard "${guard.name}" failed unexpectedly.`));
    }
  }
  return ok(undefined);
}
