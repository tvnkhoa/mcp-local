/**
 * This server's response surface.
 *
 * Deliberately thin. The dispatch pipeline in `@mcp/sdk` already reads `profile` from the raw
 * arguments and serializes whatever a handler returns, so a handler returns `ok(payload)` and
 * nothing here has to be called on the happy path.
 *
 * What lives here is the part that is this server's own: the zod fragment its tools share, so the
 * accepted profile values are declared once. Add real shaping here only when this server needs
 * something `@mcp/core`'s normalization does not do.
 */

import type { ResponseProfile } from "@mcp/core";
import { z } from "zod";

export type { ResponseProfile };

export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

/** `compact` is the workspace default for read tools: minified JSON, nullish fields dropped. */
export const DEFAULT_PROFILE: ResponseProfile = "compact";
