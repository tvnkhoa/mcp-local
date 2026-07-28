/**
 * Batch 2 — search. Resolution-sensitive: these are the tools whose ranking behaviour the
 * suites pin (S-32).
 *
 * Same construction as batch 1 and for the same reasons: zod schemas imported from
 * `schemas/toolSchemas.ts`, JSON Schemas moved from the descriptor table unedited, handlers
 * called unchanged, `rawResult: true` so each keeps resolving its own profile and emitting its
 * own telemetry. See `readMetadata.ts` for why that last point is load-bearing rather than
 * merely convenient.
 *
 * Two schemas here are the reason `JsonSchemaNode` had to be widened in S-31: `search_regex`
 * advertises `oneOf` on `filePathPrefix`/`pathExclude` (scalar or array), and `query_graph`
 * advertises `additionalProperties: true` on its free-form `params` map.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool } from "@mcp/sdk";

import {
  handleFindSymbolAtLine,
  handleGetSymbolDetail,
  handleGetSymbolSource,
  handleSearchLiterals,
  handleSearchRegex,
  handleSearchSymbols
} from "../handlers/searchHandler.js";
import { handleFindImplementations } from "../handlers/analysisHandler.js";
import { handleQueryGraph, handleRouteMap } from "../handlers/impactHandler.js";
import * as schemas from "../schemas/toolSchemas.js";

import { PROFILE_PROP, raw, readsGraph, type CodebaseIndexDeps } from "./common.js";

export function buildSearchTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  const { limits, buildContext } = deps;

  const searchSymbols = defineTool({
    name: "search_symbols",
    description: "Search symbols across all repos or a specific repo. strategy=name is strict name/signature matching; strategy=intent uses broader tokenized matching (multi-word natural-language queries work, e.g. 'send notification email'). ranked=true returns scored/ranked candidates (with qualifiedName 'EnclosingType.Member' for class members; enclosing-type names participate in intent matching; test files get a rank penalty) and honors strategy plus the kind/language/filePath filters. excludeTests=true drops test-path results entirely.",
    input: schemas.searchSymbolsSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        repoId: { type: "string" },
        language: { type: "string" },
        kind: { type: "string" },
        filePath: { type: "string" },
        strategy: { type: "string", enum: ["name", "intent"] },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        compact: { type: "boolean" },
        profile: PROFILE_PROP,
        ranked: { type: "boolean" },
        excludeTests: { type: "boolean" }
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleSearchSymbols(input, buildContext())))
  });

  const searchRegex = defineTool({
    name: "search_regex",
    description: "Search repo source by REGEX and get matches with context lines + the enclosing symbol. Use this instead of baseline grep for arbitrary pattern searches (TODO/FIXME sweeps, API-usage hunts, call-site patterns, config keys). Scans indexed files by default; set scanAll=true to also walk non-code text files (json/yaml/etc). Flags limited to [ims] (g is implicit). filePathPrefix (string OR array of prefixes, OR-semantics) / language / excludeTests narrow scope; pathExclude (minimatch glob or array, e.g. \"**/Tests/**\") subtracts subtrees; contextLines controls surrounding lines (returned in every profile except nano). Results cap at `limit` and a per-file cap — `truncated`/`truncationReason` flag when capped.",
    input: schemas.searchRegexSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "pattern"],
      properties: {
        repoId: { type: "string" },
        pattern: { type: "string" },
        regexFlags: { type: "string", description: "Subset of i, m, s (g is always applied)." },
        filePathPrefix: {
          description: "Path prefix, or array of prefixes (a file is in scope if it starts with ANY).",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }]
        },
        pathExclude: {
          description: "Minimatch glob, or array of globs, matched against the full repo-relative path, to subtract from scope (e.g. \"**/Tests/**\", \"**/*.generated.cs\"). A leading \"*\" does not cross \"/\", so use \"**/*.ext\" to match nested files.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }]
        },
        language: { type: "string" },
        excludeTests: { type: "boolean" },
        scanAll: { type: "boolean" },
        contextLines: { type: "integer", minimum: 0, maximum: 10 },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleSearchRegex(input, buildContext())))
  });

  const searchLiterals = defineTool({
    name: "search_literals",
    description: "Search string-literal CONTENT (notification titles, error messages, log templates, user-facing text) across a repo's indexed code. Returns each literal with file, line, and enclosing symbol — use for 'what text does this repo emit' audits (notification catalogs, error-message inventories, i18n sweeps) instead of grep. Interpolated/template strings are indexed with {…} placeholders.",
    input: schemas.searchLiteralsSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "query"],
      properties: {
        repoId: { type: "string" },
        query: { type: "string" },
        filePath: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleSearchLiterals(input, buildContext())))
  });

  const getSymbolSource = defineTool({
    name: "get_symbol_source",
    description: "Return the raw source text span of a symbol (by symbolId or name) read from disk — so you can read the exact code without a separate file read. Uses the persisted end-line when available (re-index to populate), else estimates the span from the next symbol. `contextLines` adds surrounding lines; `maxLines` caps output. A stale index is reported as a non-fatal `staleWarning` (line numbers may differ from HEAD).",
    input: schemas.getSymbolSourceSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string" },
        contextLines: { type: "integer", minimum: 0, maximum: 50 },
        maxLines: { type: "integer", minimum: 1, maximum: 2000 },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetSymbolSource(input, buildContext())))
  });

  const getSymbolDetail = defineTool({
    name: "get_symbol_detail",
    description: "Get full detail for a symbol by ID — returns the symbol record plus all outgoing and incoming edges with resolved names. Use after search_symbols to drill into a specific symbol.",
    input: schemas.getSymbolDetailSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "symbolId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit }
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetSymbolDetail(input, buildContext())))
  });

  const findSymbolAtLine = defineTool({
    name: "find_symbol_at_line",
    description: "Find the symbol enclosing a given line number in a file. Use when you have a file path and line from a stack trace, error message, or diff hunk to get the symbolId for further graph queries — avoids a manual search hop.",
    input: schemas.findSymbolAtLineSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "filePath", "line"],
      properties: {
        repoId: { type: "string" },
        filePath: { type: "string" },
        line: { type: "integer", minimum: 1 }
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindSymbolAtLine(input, buildContext())))
  });

  const findImplementations = defineTool({
    name: "find_implementations",
    description: "Find all classes or structs that implement a named interface (via IMPLEMENTS edges). Useful for .NET/C# DI tracing — e.g. find_implementations('IUserRepository') to locate concrete implementations. Requires C# indexing.",
    input: schemas.findImplementationsSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "interfaceName"],
      properties: {
        repoId: { type: "string" },
        interfaceName: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit }
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindImplementations(input, buildContext())))
  });

  const routeMap = defineTool({
    name: "route_map",
    description: "Map ASP.NET C# routes to handler methods using extracted route attributes ([Route], [HttpGet], [HttpPost], ...). Use to inspect API surface deterministically.",
    input: schemas.routeMapSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        filePathPrefix: { type: "string" },
        httpMethod: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleRouteMap(input, buildContext())))
  });

  const queryGraph = defineTool({
    name: "query_graph",
    // Kept as an array joined with " ", exactly as the descriptor built it. Rewriting it as one
    // string literal risks a whitespace difference, and this description is contract.
    description: [
      "Run a read-only SQL query against graph tables in a sandboxed mode.",
      "Requires :repoId named parameter in SQL and blocks write/admin statements.",
      "Allowed tables: repositories, files, symbols, edges, index_runs, routes, cross_repo_deps, refactor_previews, refactor_preview_hunks, refactor_applies, refactor_apply_changes, refactor_apply_hunks, refactor_rollbacks, vec_symbol_map.",
      "Key columns — symbols: (repo_id, symbol_id, name, kind, file_path, line, signature);",
      "edges: (repo_id, from_id, to_id, type, confidence, reason) — type values: CALLS, IMPORTS, TYPE_REF, DEPENDS_ON, PROPERTY_REF, PROPERTY_WRITE;",
      "cross_repo_deps: (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type);",
      "routes: (repo_id, file_path, controller_symbol_id, handler_symbol_id, http_method, route_template, line).",
      "Note: 'package_consumers' is not a table — query edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%' instead."
    ].join(" "),
    input: schemas.queryGraphSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "sql"],
      properties: {
        repoId: { type: "string" },
        sql: { type: "string" },
        params: { type: "object", additionalProperties: true },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
        profile: PROFILE_PROP
      }
    },
    // Read-only despite taking SQL: `guardrails/sqliteGuardrails.ts` rejects every mutation and
    // admin token before the statement reaches SQLite. That guard is what makes this annotation
    // true, so it must not be relaxed.
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleQueryGraph(input, buildContext())))
  });

  return [
    searchSymbols,
    searchRegex,
    searchLiterals,
    getSymbolSource,
    getSymbolDetail,
    findSymbolAtLine,
    findImplementations,
    routeMap,
    queryGraph
  ];
}
