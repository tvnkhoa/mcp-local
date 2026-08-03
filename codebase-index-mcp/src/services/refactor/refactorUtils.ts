import { createHash } from "node:crypto";

import {
  describePreviewTokenRejection,
  issuePreviewToken,
  verifyPreviewToken
} from "@mcp/shared";
import fs from "node:fs";
import path from "node:path";

import type { RefactorRiskFlag, RefactorPreviewHunkRecord } from "../../types/index.js";
import type {
  PreviewCandidateHunk,
  ObjectInitializerContext,
  InitializerAssignmentContext,
  RefactorSymbolMigrationInput
} from "./refactorTypes.js";

export class PolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function safeReadText(absolutePath: string): string {
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
}

export function assertSafeRepoFilePath(repoPath: string, relativePath: string): string {
  const fullPath = path.resolve(repoPath, relativePath);
  const normalizedRepo = path.resolve(repoPath);
  if (!fullPath.startsWith(normalizedRepo + path.sep) && fullPath !== normalizedRepo) {
    throw new PolicyViolationError("PATH_TRAVERSAL_BLOCKED", `Blocked path outside repo root: ${relativePath}`);
  }
  return fullPath;
}

export type SymbolSourceSpan = {
  source: string;
  symbolStartLine: number;
  symbolEndLine: number;
  endLineEstimated: boolean;
  startLine: number;
  endLine: number;
  lineCount: number;
  truncated: boolean;
};

/**
 * Read a symbol's source span from disk (path-guarded). Shared by get_symbol_source and
 * get_feature_bundle so both read spans identically. The caller resolves the end line:
 * prefer the persisted `symbolEndLine`; when absent, pass `fallbackNextStartLine` (the next
 * symbol's start line) so the span ends just before it, else a bounded window is used.
 * Returns null when the file is missing/empty on disk.
 */
export function readSymbolSourceSpan(
  repoPath: string,
  filePath: string,
  symbolStartLine: number,
  symbolEndLine: number | null,
  opts: { contextLines: number; maxLines: number; fallbackNextStartLine?: number | null }
): SymbolSourceSpan | null {
  const absolute = assertSafeRepoFilePath(repoPath, filePath.replace(/\\/g, "/"));
  const content = safeReadText(absolute);
  if (!content) return null;
  const lines = content.split(/\r?\n/);

  let endLine = symbolEndLine ?? null;
  let endLineEstimated = false;
  if (!endLine || endLine < symbolStartLine) {
    endLineEstimated = true;
    const next = opts.fallbackNextStartLine ?? null;
    endLine = next && next - 1 >= symbolStartLine ? next - 1 : Math.min(lines.length, symbolStartLine + 200);
  }

  const from = Math.max(1, symbolStartLine - opts.contextLines);
  let to = Math.min(lines.length, endLine + opts.contextLines);
  let truncated = false;
  if (to - from + 1 > opts.maxLines) {
    to = from + opts.maxLines - 1;
    truncated = true;
  }

  return {
    source: lines.slice(from - 1, to).join("\n"),
    symbolStartLine,
    symbolEndLine: endLine,
    endLineEstimated,
    startLine: from,
    endLine: to,
    lineCount: to - from + 1,
    truncated
  };
}

export function inferLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".cs") return "csharp";
  if (ext === ".py") return "python";
  if (ext === ".java") return "java";
  return ext.replace(/^\./, "") || "unknown";
}

export function isGeneratedFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes("/generated/") || lower.endsWith(".g.ts") || lower.endsWith(".g.cs") || lower.endsWith(".generated.ts") || lower.endsWith(".generated.cs");
}

export function offsetToLine(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTypeToken(typeName: string): string {
  const withoutNamespace = typeName.split(".").pop() ?? typeName;
  return withoutNamespace.replace(/<.*>/g, "").trim();
}

function findMatchingBraceEnd(content: string, openBraceOffset: number): number {
  let depth = 0;
  for (let i = openBraceOffset; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

export function findEnclosingObjectInitializer(content: string, offset: number): ObjectInitializerContext | null {
  const prefix = content.slice(0, Math.max(0, offset));
  const matches = [...prefix.matchAll(/new\s+([A-Za-z_][A-Za-z0-9_.<>?,]*)\s*\{/g)];

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const openBraceOffset = (match.index ?? 0) + match[0].lastIndexOf("{");
    const endOffset = findMatchingBraceEnd(content, openBraceOffset);
    if (endOffset < 0) {
      continue;
    }
    if (offset >= openBraceOffset && offset <= endOffset) {
      return {
        typeName: normalizeTypeToken(match[1] ?? ""),
        openBraceOffset,
        endOffset
      };
    }
  }

  return null;
}

function findEnclosingClassName(content: string, offset: number): string | null {
  const prefix = content.slice(0, Math.max(0, offset));
  const classMatches = [...prefix.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  if (classMatches.length > 0) {
    return classMatches[classMatches.length - 1][1] ?? null;
  }
  return null;
}

export function findOwnerType(content: string, offset: number): string | null {
  const initializer = findEnclosingObjectInitializer(content, offset);
  if (initializer) {
    return initializer.typeName;
  }
  return findEnclosingClassName(content, offset);
}

export function inferSymbolKind(lineText: string): "class" | "property" | "field" | "method" | null {
  const text = lineText.trim();
  if (/\bclass\b/.test(text)) return "class";
  if (/\b(get|set)\b/.test(text) || /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text)) return "method";
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(text)) return "property";
  if (/\b(private|public|protected)\s+[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(text)) return "field";
  return null;
}

export function pathStartsWithAny(filePath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) {
    return true;
  }
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(normalizeRelativePath(prefix).toLowerCase()));
}

export function hasNormalizedPathPrefix(normalizedPath: string, normalizedPrefix: string): boolean {
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function resolveDiagnosticPathToHunkPath(
  diagnosticPath: string,
  hunkPathByLower: Map<string, string>
): string | null {
  const normalizedDiagPath = normalizeRelativePath(diagnosticPath).toLowerCase();
  const exact = hunkPathByLower.get(normalizedDiagPath);
  if (exact) {
    return exact;
  }

  let bestMatch: string | null = null;
  for (const [lowerPath, canonical] of hunkPathByLower.entries()) {
    if (normalizedDiagPath.endsWith(`/${lowerPath}`) || normalizedDiagPath === lowerPath) {
      if (!bestMatch || lowerPath.length > bestMatch.length) {
        bestMatch = lowerPath;
      }
      if (normalizedDiagPath === lowerPath) {
        break;
      }
    }
    if (normalizedDiagPath.endsWith(`\\${lowerPath}`)) {
      if (!bestMatch || lowerPath.length > bestMatch.length) {
        bestMatch = lowerPath;
      }
    }
  }

  if (!bestMatch) {
    return null;
  }
  return hunkPathByLower.get(bestMatch) ?? null;
}

export function findInitializerMemberAssignment(
  content: string,
  offset: number,
  symbolName: string
): InitializerAssignmentContext | null {
  const initializer = findEnclosingObjectInitializer(content, offset);
  if (!initializer) {
    return null;
  }

  const lineStart = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const rawLineEnd = content.indexOf("\n", offset);
  const lineEnd = rawLineEnd >= 0 ? rawLineEnd : content.length;
  const lineText = content.slice(lineStart, lineEnd);
  const lineEnding = rawLineEnd >= 0 ? (content[lineEnd - 1] === "\r" ? "\r\n" : "\n") : "";
  const assignmentEnd = rawLineEnd >= 0 ? lineEnd + lineEnding.length : lineEnd;

  const headPattern = new RegExp(`^(\\s*)${escapeRegExp(symbolName)}\\s*=\\s*`);
  const match = lineText.match(headPattern);
  if (!match) {
    return null;
  }

  const indent = match[1] ?? "";
  const rhs = lineText.slice(match[0].length);
  if (rhs.length === 0) {
    return null;
  }

  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let splitIndex = -1;

  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      splitIndex = i;
      break;
    }
  }

  const expressionText = (splitIndex >= 0 ? rhs.slice(0, splitIndex) : rhs).trim();
  if (expressionText.length === 0) {
    return null;
  }

  const remainder = splitIndex >= 0 ? rhs.slice(splitIndex + 1).trim() : "";
  const hasSiblingAssignments = splitIndex >= 0 && /[A-Za-z_][A-Za-z0-9_]*\s*=/.test(remainder);

  return {
    initializer,
    assignmentStart: lineStart,
    assignmentEnd,
    assignmentText: content.slice(lineStart, assignmentEnd),
    indent,
    expressionText,
    trailingComma: splitIndex >= 0,
    hasSiblingAssignments,
    line: offsetToLine(content, lineStart),
    lineEnding
  };
}

export function isDottedMemberPath(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value.trim());
}

function isSimpleIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

export function isInvalidCsharpInitializerReplacement(replacementText: string): boolean {
  const trimmed = replacementText.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed);
}

export function resolveInitializerRewriteTargetMember(migration: RefactorSymbolMigrationInput): string {
  const targetMember = migration.initializerRewrite?.targetMember
    ?? migration.toSymbol.split(".").filter((x) => x.length > 0).at(-1)
    ?? migration.fromSymbol;

  const objectProperty = migration.initializerRewrite?.objectProperty;
  const objectType = migration.initializerRewrite?.objectType;

  if (objectProperty && !isSimpleIdentifier(objectProperty)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.objectProperty must be a simple identifier (received '${objectProperty}').`
    );
  }

  if (!isSimpleIdentifier(targetMember)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.targetMember must be a simple identifier (received '${targetMember}').`
    );
  }

  if (objectType && /[=;{}]/.test(objectType)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.objectType contains invalid characters (received '${objectType}').`
    );
  }

  return targetMember;
}

export function isApplyRunnableHunk(hunk: RefactorPreviewHunkRecord, includeLowConfidence: boolean, lowConfidenceThreshold: number): boolean {
  if (hunk.riskFlags.length > 0) {
    return false;
  }
  if (!includeLowConfidence && hunk.confidence < lowConfidenceThreshold) {
    return false;
  }
  return true;
}

export function collectExpectedApplyFiles(hunks: RefactorPreviewHunkRecord[], includeLowConfidence: boolean, lowConfidenceThreshold: number): Set<string> {
  return new Set(hunks.filter((h) => isApplyRunnableHunk(h, includeLowConfidence, lowConfidenceThreshold)).map((h) => h.filePath));
}

export function countPreviewRisks(hunks: Array<{ riskFlags: RefactorRiskFlag[] }>): { ambiguous: number; crossType: number; generated: number } {
  let ambiguous = 0;
  let crossType = 0;
  let generated = 0;
  for (const hunk of hunks) {
    if (hunk.riskFlags.includes("ambiguous_target")) ambiguous += 1;
    if (hunk.riskFlags.includes("cross_type")) crossType += 1;
    if (hunk.riskFlags.includes("generated_file")) generated += 1;
  }
  return { ambiguous, crossType, generated };
}

export function createPreviewDigest(repoId: string, findText: string, replaceText: string, hunks: PreviewCandidateHunk[]): string {
  const stable = JSON.stringify({
    repoId,
    findText,
    replaceText,
    hunks: hunks.map((h) => ({
      filePath: h.filePath,
      startOffset: h.startOffset,
      endOffset: h.endOffset,
      beforeText: h.beforeText,
      afterText: h.afterText,
      ownerType: h.ownerType,
      symbolKind: h.symbolKind,
      confidence: h.confidence,
      riskFlags: [...h.riskFlags].sort((a, b) => a.localeCompare(b)),
      fileHashBefore: h.fileHashBefore
    }))
  });
  return sha256(stable);
}

/**
 * Issue the refactor approval token.
 *
 * The HMAC construction and token format are shared with postgres-mcp via
 * `@mcp/shared`: the two hand-copied implementations produced byte-identical
 * tokens, so sharing them is behaviour-preserving.
 */
export function issueApprovalToken(previewId: string, digest: string, expiresAt: string, secret: string): string {
  return issuePreviewToken({ previewId, digest, expiresAt }, secret);
}

/**
 * Verify the refactor approval token.
 *
 * Signature comparison is now constant-time (it was `expected !== signature`,
 * which short-circuits on the first differing byte). Verdicts are unchanged for
 * every input — proven against a 14-case characterization of both servers — so
 * this closes a timing channel without altering behaviour.
 *
 * `PolicyViolationError` is raised here rather than in the shared module because
 * the exception type and its codes are this server's contract.
 */
export function verifyApprovalToken(token: string, previewId: string, digest: string, expiresAt: string, secret: string): void {
  const verdict = verifyPreviewToken(token, { previewId, digest, expiresAt }, secret);
  if (!verdict.ok) {
    const { code, message } = describePreviewTokenRejection(verdict.reason);
    throw new PolicyViolationError(code, message);
  }
}

export function groupPreviewHunks(hunks: RefactorPreviewHunkRecord[]): Array<{
  filePath: string;
  hunkCount: number;
  hunks: Array<{
    hunkId: string;
    line: number;
    beforeText: string;
    afterText: string;
    confidence: number;
    riskFlags: RefactorRiskFlag[];
    ownerType: string | null;
    symbolKind: string | null;
  }>;
}> {
  const byFile = new Map<string, RefactorPreviewHunkRecord[]>();
  for (const hunk of hunks) {
    const list = byFile.get(hunk.filePath) ?? [];
    list.push(hunk);
    byFile.set(hunk.filePath, list);
  }

  return [...byFile.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([filePath, items]) => ({
      filePath,
      hunkCount: items.length,
      hunks: items.map((item) => ({
        hunkId: item.hunkId,
        line: item.line,
        beforeText: item.beforeText,
        afterText: item.afterText,
        confidence: item.confidence,
        riskFlags: item.riskFlags,
        ownerType: item.ownerType,
        symbolKind: item.symbolKind
      }))
    }));
}

export function buildFinalOffsetMap(hunks: RefactorPreviewHunkRecord[]): Map<string, number> {
  const sortedAsc = [...hunks].sort((a, b) => a.startOffset - b.startOffset || a.hunkId.localeCompare(b.hunkId));
  const offsetMap = new Map<string, number>();
  let cumulativeDelta = 0;

  for (const hunk of sortedAsc) {
    const adjustedStart = hunk.startOffset + cumulativeDelta;
    offsetMap.set(hunk.hunkId, adjustedStart);
    cumulativeDelta += hunk.replacementText.length - hunk.beforeText.length;
  }

  return offsetMap;
}

export function mapPreviewStatusFromApplyStatus(status: "applied" | "partial" | "failed"): "applied" | "apply_partial" | "apply_failed" {
  if (status === "applied") {
    return "applied";
  }
  if (status === "partial") {
    return "apply_partial";
  }
  return "apply_failed";
}

export function deriveApplyStatus(changes: Array<{ status: string }>): "applied" | "partial" | "failed" {
  const hasApplied = changes.some((x) => x.status === "applied");
  if (!hasApplied) {
    return "failed";
  }
  const hasNonApplied = changes.some((x) => x.status !== "applied");
  if (hasNonApplied) {
    return "partial";
  }
  return "applied";
}

export function noLlmAudit(strictApproval: boolean): { decisionSource: "rule_engine"; llmInvolved: false; approvalMode: "strict" | "local-fallback" } {
  return {
    decisionSource: "rule_engine",
    llmInvolved: false,
    approvalMode: strictApproval ? "strict" : "local-fallback"
  };
}

export function resolveApprovalSecret(secret: string, strictApproval: boolean): string {
  if (secret.trim().length > 0) {
    return secret;
  }
  if (strictApproval) {
    throw new PolicyViolationError(
      "APPROVAL_SECRET_REQUIRED",
      "Approval secret is required in strict approval mode. Set CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET."
    );
  }
  return "dev-insecure-secret";
}
