/**
 * dotnetProjectParser.ts
 *
 * Parses .csproj and .sln files to extract project dependencies
 * as DEPENDS_ON edges in the graph. No tree-sitter needed — these are
 * XML/text formats we can parse with simple regex.
 */

import { createHash } from "node:crypto";

import type { EdgeRecord, SymbolRecord } from "./types.js";

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

function extractTagValue(source: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "i");
  const match = re.exec(source);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
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
  const projectSymbolId = stableId(`${input.repoId}:${input.filePath}:module:${projectName}`);

  symbols.push({
    repoId: input.repoId,
    symbolId: projectSymbolId,
    filePath: input.filePath,
    name: projectName,
    kind: "module",
    line: 1
  });

  // Provider-side bridge symbol: when PackageId is declared, emit a synthetic
  // module symbol tagged with signature=nuget:<package>. Cross-repo resolver
  // can map consumer PackageReference contracts to this provider symbol.
  const packageId = extractTagValue(input.source, "PackageId");
  if (packageId) {
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
    const refPath = match[1].replace(/\\/g, "/");
    if (!refPath) continue;

    edges.push({
      repoId: input.repoId,
      fromId: projectSymbolId,
      toId: stableId(`${input.repoId}:project:${refPath.toLowerCase()}`),
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
    const projPath = match[2].replace(/\\/g, "/");
    if (!projName || !projPath) continue;

    // Use a sln-scoped symbolId so two .sln files referencing the same .csproj
    // don't emit conflicting symbols with the same symbolId.
    const projSymbolId = stableId(`${input.repoId}:${input.filePath}:project:${projPath.toLowerCase()}`);

    symbols.push({
      repoId: input.repoId,
      symbolId: projSymbolId,
      filePath: input.filePath,  // owned by this .sln, not the .csproj path
      name: projName,
      kind: "module",
      line: 1
    });

    edges.push({
      repoId: input.repoId,
      fromId: slnSymbolId,
      toId: projSymbolId,
      type: "DEPENDS_ON"
    });
  }

  return { symbols, edges };
}
