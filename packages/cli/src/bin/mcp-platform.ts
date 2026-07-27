#!/usr/bin/env node
/**
 * mcp-platform — workspace tooling entry point.
 *
 * Usage:
 *   mcp-platform guard [deps|convention|all] [--strict] [--servers a,b]
 *   mcp-platform packages
 *   mcp-platform rules
 *
 * Guards default to warn mode: findings are printed, exit code stays 0 unless
 * a blocking error exists. `--strict` also fails on warnings.
 */

import { exitCodeFor, renderReport, renderSummary } from "../report.js";
import { TIER_RULES, runConventionGuard, runDependencyGuard } from "../guards/index.js";
import type { GuardReport } from "../guards/index.js";
import { findWorkspaceRoot, readWorkspacePackages } from "../scan.js";

interface ParsedArgs {
  readonly command: string;
  readonly subcommand: string;
  readonly strict: boolean;
  readonly servers: readonly string[];
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let strict = false;
  let help = false;
  let servers: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--servers") {
      const value = argv[index + 1];
      if (value !== undefined) {
        servers = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
        index += 1;
      }
    } else if (arg.startsWith("--servers=")) {
      servers = arg
        .slice("--servers=".length)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? "help",
    subcommand: positional[1] ?? "all",
    strict,
    servers,
    help
  };
}

const USAGE = `mcp-platform — internal MCP platform tooling

Commands:
  guard [deps|convention|all]   Run architecture guards (default: all)
      --strict                  Fail on warnings as well as errors
      --servers a,b             Also check these server directories
  packages                      List workspace packages and their tiers
  rules                         Print the dependency tier matrix
  help                          Show this message
`;

function commandGuard(args: ParsedArgs): number {
  const workspaceRoot = findWorkspaceRoot();
  const reports: GuardReport[] = [];

  if (args.subcommand === "deps" || args.subcommand === "all") {
    reports.push(
      runDependencyGuard({
        workspaceRoot,
        ...(args.servers.length === 0 ? {} : { serverDirs: args.servers })
      })
    );
  }
  if (args.subcommand === "convention" || args.subcommand === "all") {
    reports.push(
      runConventionGuard({
        workspaceRoot,
        ...(args.servers.length === 0 ? {} : { extraDirs: args.servers.map((dir) => `${dir}/src`) })
      })
    );
  }

  if (reports.length === 0) {
    process.stderr.write(`unknown guard "${args.subcommand}"\n${USAGE}`);
    return 2;
  }

  for (const report of reports) {
    process.stderr.write(`${renderReport(report, { strict: args.strict })}\n\n`);
  }
  process.stdout.write(`${renderSummary(reports)}\n`);

  return exitCodeFor(reports, { strict: args.strict });
}

function commandPackages(): number {
  const workspaceRoot = findWorkspaceRoot();
  const packages = readWorkspacePackages(workspaceRoot);
  const lines = packages.map((pkg) => {
    const rule = TIER_RULES.find((entry) => entry.name === pkg.name);
    const tier = rule === undefined ? "?" : String(rule.tier);
    return `  tier ${tier}  ${pkg.name.padEnd(16)} ${pkg.relativeDir}`;
  });
  process.stdout.write(`${packages.length} package(s)\n${lines.join("\n")}\n`);
  return 0;
}

function commandRules(): number {
  const lines = TIER_RULES.map((rule) => {
    const allowed = rule.mayImport.length === 0 ? "(nothing)" : rule.mayImport.join(", ");
    const external =
      rule.allowedExternal === undefined
        ? "(unrestricted)"
        : rule.allowedExternal.length === 0
          ? "(none — zero-dependency)"
          : rule.allowedExternal.join(", ");
    return `  tier ${rule.tier}  ${rule.name}\n      internal: ${allowed}\n      external: ${external}`;
  });
  process.stdout.write(`dependency tier matrix\n${lines.join("\n")}\n`);
  return 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case "guard":
      return commandGuard(args);
    case "packages":
      return commandPackages();
    case "rules":
      return commandRules();
    default:
      process.stderr.write(`unknown command "${args.command}"\n${USAGE}`);
      return 2;
  }
}

process.exitCode = main();
