/**
 * dotnetProjectParser.ts
 *
 * Parses .csproj and .sln files to extract project dependencies
 * as DEPENDS_ON edges in the graph. No tree-sitter needed — these are
 * XML/text formats we can parse with simple regex.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";

export type DotnetExtractInput = {
  repoId: string;
  filePath: string;
  language: "csproj" | "sln";
  source: string;
};

export type DotnetExtractResult = {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  docs?: never;
  mentions?: never;
};

function normalizeNugetContractId(value: string): string {
  return `nuget:${value.trim().toLowerCase()}`;
}

/**
 * Whether a .csproj should emit a provider-side nuget-export bridge symbol.
 * Returns false for projects that NuGet would never pack, so they don't add
 * phantom provider symbols that collide with real package contract ids (ISSUE-CR-001).
 * Detected without MSBuild evaluation, tolerant of tag attributes:
 *   - <IsPackable ...>false</IsPackable>
 *   - <IsTestProject ...>true</IsTestProject>
 *   - a Microsoft.NET.Test.Sdk PackageReference (test SDK defaults IsPackable to false)
 */
function isProjectPackable(source: string): boolean {
  if (/<IsPackable[^>]*>\s*false\s*<\/IsPackable>/i.test(source)) return false;
  if (/<IsTestProject[^>]*>\s*true\s*<\/IsTestProject>/i.test(source)) return false;
  if (/<PackageReference\s+Include="Microsoft\.NET\.Test\.Sdk"/i.test(source)) return false;
  return true;
}

function extractTagValue(source: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "i");
  const match = re.exec(source);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

/**
 * The canonical spelling of a repo-relative project path: forward slashes, `.`/`..` folded, no
 * leading `./`, lower-cased. The pipeline hands extractors `path.relative` output, which uses
 * backslashes on Windows, and a `<ProjectReference>` may spell the same file with either separator
 * or different casing (MSBuild on Windows is case-insensitive). Keying the id on this form is what
 * lets a reference and the referenced project agree on one id (MCP-ISSUE-065).
 */
function canonicalProjectPath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.trim().replace(/\\/g, "/"));
  return normalized.replace(/^(\.\/)+/, "").toLowerCase();
}

/**
 * The id of a project's module symbol. The ONLY way to spell it: the `.csproj` lane mints its own
 * module symbol with it, and every `<ProjectReference>` and `.sln` project edge mints its `to_id`
 * with it. Before MCP-ISSUE-065 the two sides used different formulas and every project edge dangled.
 */
function projectModuleSymbolId(repoId: string, projectFilePath: string): string {
  const canonical = canonicalProjectPath(projectFilePath);
  const name = canonical.split("/").pop()?.replace(/\.csproj$/i, "") ?? "unknown";
  return stableId(`${repoId}:${canonical}:module:${name}`);
}

type ProjectTarget = { toId: string; confidence: number; reason: string };

/**
 * Where a project path written inside `ownerFilePath` (a `.csproj` or `.sln`) points.
 *
 * - Inside the repo: the referenced project's module symbol id.
 * - Climbs out of the repo, or is absolute: `project:<path>` tagged `external boundary`. It can
 *   never be a symbol of this repo, and the unresolved-edge policy keeps such a reference labelled
 *   rather than dropping it.
 * - Built from an MSBuild property (`$(SolutionDir)…`): not knowable without evaluating MSBuild, so
 *   `project:<raw>` as an unresolved token.
 *
 * Never a bare hex id that matches nothing: a resolved-looking dangling id is read as a stale edge by
 * the MCP-ISSUE-063 prune and deleted on the next incremental run.
 */
function resolveProjectTarget(repoId: string, ownerFilePath: string, rawRef: string): ProjectTarget {
  const ref = rawRef.trim().replace(/\\/g, "/");
  if (ref.includes("$(")) {
    return { toId: `project:${ref.toLowerCase()}`, confidence: 0.3, reason: "unresolved project reference token" };
  }
  if (ref.startsWith("/") || /^[a-z]:\//i.test(ref)) {
    return { toId: `project:${canonicalProjectPath(ref)}`, confidence: 0.1, reason: "external boundary" };
  }
  const ownerDir = path.posix.dirname(ownerFilePath.replace(/\\/g, "/"));
  const joined = canonicalProjectPath(path.posix.join(ownerDir, ref));
  if (joined === ".." || joined.startsWith("../")) {
    return { toId: `project:${joined}`, confidence: 0.1, reason: "external boundary" };
  }
  return { toId: projectModuleSymbolId(repoId, joined), confidence: 1, reason: "project reference" };
}

export function extractDotnetProjectData(input: DotnetExtractInput): DotnetExtractResult {
  if (input.language === "csproj") {
    return extractCsproj(input);
  }
  if (input.language === "sln") {
    return extractSln(input);
  }
  return { symbols: [], edges: [] };
}

function extractCsproj(input: DotnetExtractInput): DotnetExtractResult {
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];

  const projectName = input.filePath.split(/[\\/]/).pop()?.replace(/\.csproj$/i, "") ?? "unknown";
  const projectSymbolId = projectModuleSymbolId(input.repoId, input.filePath);

  symbols.push({
    repoId: input.repoId,
    symbolId: projectSymbolId,
    filePath: input.filePath,
    name: projectName,
    kind: "module",
    line: 1
  });

  // Provider-side bridge symbol: emit a synthetic module symbol tagged with
  // signature=nuget:<package> so the cross-repo resolver can map consumer
  // PackageReference contracts to this provider symbol.
  //
  // PackageId is only set explicitly in a minority of .csproj files. NuGet falls
  // back to AssemblyName, then to the project file name, when <PackageId> is absent
  // (https://learn.microsoft.com/en-us/nuget/reference/msbuild-targets#pack-target).
  // Mirroring that default is what makes the bridge resolve for real provider repos
  // (e.g. SSNet.CommunicationHub.Messaging) that never declare <PackageId> (ISSUE-CR-001).
  // Skips non-packable projects (test projects, IsPackable=false) so they don't emit a
  // phantom provider symbol that collides with real package contract ids — see
  // isProjectPackable.
  if (isProjectPackable(input.source)) {
    const packageId = extractTagValue(input.source, "PackageId")
      ?? extractTagValue(input.source, "AssemblyName")
      ?? projectName;
    const contractId = normalizeNugetContractId(packageId);
    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:nuget-export:${contractId}`),
      filePath: input.filePath,
      name: packageId,
      kind: "module",
      line: 1,
      signature: contractId
    });
  }

  // Extract <PackageReference Include="..." Version="..." />
  const pkgRefRe = /<PackageReference\s+Include="([^"]+)"(?:[^>]*Version="([^"]*)")?/gi;
  let match: RegExpExecArray | null;

  while ((match = pkgRefRe.exec(input.source)) !== null) {
    const packageName = match[1];
    const packageVersion = match[2]?.trim() || null;
    if (!packageName) continue;

    edges.push({
      repoId: input.repoId,
      fromId: projectSymbolId,
      toId: normalizeNugetContractId(packageName),
      type: "DEPENDS_ON",
      reason: packageVersion ? `nuget package reference (${packageVersion})` : "nuget package reference"
    });
  }

  // Extract <ProjectReference Include="..." />
  const projRefRe = /<ProjectReference\s+Include="([^"]+)"/gi;

  while ((match = projRefRe.exec(input.source)) !== null) {
    const refPath = match[1];
    if (!refPath?.trim()) continue;

    edges.push({
      repoId: input.repoId,
      fromId: projectSymbolId,
      ...resolveProjectTarget(input.repoId, input.filePath, refPath),
      type: "DEPENDS_ON"
    });
  }

  return { symbols, edges };
}

function extractSln(input: DotnetExtractInput): DotnetExtractResult {
  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];

  const slnName = input.filePath.split(/[\\/]/).pop()?.replace(/\.sln$/i, "") ?? "unknown";
  const slnSymbolId = stableId(`${input.repoId}:${input.filePath}:module:${slnName}`);

  symbols.push({
    repoId: input.repoId,
    symbolId: slnSymbolId,
    filePath: input.filePath,
    name: slnName,
    kind: "module",
    line: 1
  });

  // Project("...") = "ProjectName", "relative/path.csproj", "{GUID}"
  const projRe = /^Project\("[^"]*"\)\s*=\s*"([^"]+)",\s*"([^"]+\.csproj)"/gim;
  let match: RegExpExecArray | null;

  while ((match = projRe.exec(input.source)) !== null) {
    const projName = match[1];
    const projPath = match[2];
    if (!projName || !projPath) continue;

    // The edge targets the project's own module symbol, minted by the .csproj lane. Until
    // MCP-ISSUE-065 the .sln minted a sln-scoped proxy `module` symbol per project instead, so every
    // project had an extra same-named module symbol owned by the .sln and the solution graph never
    // reached the real one.
    edges.push({
      repoId: input.repoId,
      fromId: slnSymbolId,
      ...resolveProjectTarget(input.repoId, input.filePath, projPath),
      type: "DEPENDS_ON"
    });
  }

  return { symbols, edges };
}
