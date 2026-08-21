/**
 * Fragments shared by every bitbucket-mcp tool group.
 *
 * These used to live inside the `buildTools` closure. They moved out when the
 * pipeline tools arrived: `tools/index.ts` was 448 lines against a 400-line soft
 * cap and a 600-line hard cap (`packages/cli/src/guards/conventionGuard.ts`), so
 * a second tool group had to be a second file — and a second file needs the
 * fragments to be importable rather than closed over.
 *
 * Nothing here reads config at module scope: `resolveRepo` takes the config it
 * needs, so this module stays a pure value bag.
 */

import { schema } from "@mcp/sdk";
import type { JsonSchemaNode } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";

/**
 * Bitbucket UUIDs, brace-stripped. Module scope on purpose: this was once
 * declared after a factory's `return`, which left it in its temporal dead zone
 * and made every reviewer call throw (pinned by a test in `tools.test.ts`).
 */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// --- shared zod fragments ---------------------------------------------------

export const profileArg = responseProfileSchema.optional();
export const repoSlugArg = z.string().min(1).max(256).optional();
export const qArg = z.string().min(1).max(512).optional();
export const sortArg = z.string().min(1).max(128).optional();
export const pageArg = z.number().int().positive().optional();
export const pagelenArg = z.number().int().positive().max(100).optional();

// --- shared JSON Schema fragments -------------------------------------------
// Deliberately NOT `schema.profile()`: that helper adds a description this
// server has never advertised, and `tools/list` is a committed contract.

export const profileProp: JsonSchemaNode = schema.enumOf([
  "nano",
  "compact",
  "standard",
  "verbose"
]);
export const repoSlugProp: JsonSchemaNode = schema.string(
  "Repo slug (default: BITBUCKET_DEFAULT_REPO)"
);
export const pageProp: JsonSchemaNode = schema.integer(undefined, { minimum: 1 });
export const pagelenProp: JsonSchemaNode = schema.integer("Page size (default 25, max 100)", {
  minimum: 1,
  maximum: 100
});

// --- helpers ----------------------------------------------------------------

/** Resolve the target repo slug from an explicit arg or the configured default. */
export function resolveRepo(config: BitbucketConfig, repoSlug: string | undefined): string {
  const slug = repoSlug?.trim() || config.defaultRepo;
  if (!slug) {
    throw new PolicyViolationError(
      "repo_required",
      "No repository specified. Pass `repoSlug` or set BITBUCKET_DEFAULT_REPO."
    );
  }
  return slug;
}

/** Summarize a Bitbucket paginated response (page/size/next flag). */
export function pageInfo(res: {
  page?: number;
  pagelen?: number;
  size?: number;
  next?: string;
}): Record<string, unknown> {
  return {
    page: res.page ?? null,
    pagelen: res.pagelen ?? null,
    size: res.size ?? null,
    hasNext: Boolean(res.next)
  };
}

// --- tiny safe accessors for untyped Bitbucket JSON -------------------------

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function get(root: unknown, ...keys: string[]): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
