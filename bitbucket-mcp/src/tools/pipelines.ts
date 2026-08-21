/**
 * The Bitbucket Pipelines tool group — read-only.
 *
 * Four tools that walk one CI failure end to end: which runs happened on a
 * branch, how one run ended, which step failed, and what that step logged.
 * Nothing here writes: triggering or stopping a pipeline is not part of this
 * server. If it is ever added it reuses `BITBUCKET_WRITE_ENABLED` and the inline
 * gate pattern from `create_pull_request` (a guard would block a dry run).
 *
 * Kept out of `tools/index.ts` because that file was already at 448 lines
 * against a 400-line soft cap.
 */

import { ok } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition, JsonSchemaNode } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { shapeStepLog } from "./pipelineLog.js";
import {
  UUID_RE,
  get,
  num,
  pageArg,
  pageInfo,
  pageProp,
  pagelenArg,
  pagelenProp,
  profileArg,
  profileProp,
  repoSlugArg,
  repoSlugProp,
  resolveRepo,
  sortArg,
  str
} from "./shared.js";

/**
 * How much of a step log to return by default, and the ceiling a caller may ask
 * for. A build log can be tens of megabytes; the useful part is the end. These
 * are constants rather than env vars because they bound one tool's response, not
 * the server's behaviour — there is nothing to tune per deployment.
 */
export const PIPELINE_LOG_DEFAULT_BYTES = 262_144;
export const PIPELINE_LOG_MAX_BYTES = 1_048_576;

/** Newest first — the run you are debugging is almost always the last one. */
const DEFAULT_PIPELINE_SORT = "-created_on";

/**
 * The `status` filter vocabulary, which is **not** the vocabulary the response
 * uses. Verified live on 2026-08-21 against a repo holding one SUCCESSFUL, two
 * FAILED and one STOPPED run:
 *
 * - `PASSED` selected the run whose `state.result.name` reads `SUCCESSFUL`;
 *   `SUCCESSFUL` and `COMPLETED` selected nothing at all.
 * - `FAILED` and `STOPPED` selected exactly their runs.
 * - An unrecognised value returns an empty page with HTTP 200 — there is no
 *   error to surface, which is why this list is closed rather than a free string.
 *
 * The in-flight values below could not be exercised (no such run existed) but are
 * Bitbucket's own state names; they are kept so a caller can watch a running
 * build, and the tool description warns that an empty page may mean a value this
 * endpoint does not know.
 */
export const PIPELINE_STATUS_VALUES = [
  "PENDING",
  "BUILDING",
  "IN_PROGRESS",
  "PAUSED",
  "HALTED",
  "PASSED",
  "FAILED",
  "ERROR",
  "STOPPED"
] as const;

export function buildPipelineTools(
  config: BitbucketConfig,
  client: BitbucketClient
): readonly AnyToolDefinition[] {
  const pipelineRefProp: JsonSchemaNode = schema.string(
    "Pipeline UUID (braces optional) or build number"
  );
  const stepUuidProp: JsonSchemaNode = schema.string("Step UUID (braces optional)");

  const listPipelinesTool = defineTool({
    name: "list_pipelines",
    description:
      "List pipeline runs of a repository, newest first. Filter by branch and/or status (several statuses are ORed). NOTE the filter vocabulary is not the response vocabulary: a run whose result reads SUCCESSFUL is selected by status PASSED. An unsupported status matches nothing rather than erroring, so an empty result can mean a wrong value. Requires the read:pipeline scope.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        branch: z.string().min(1).max(512).optional(),
        status: z.array(z.enum(PIPELINE_STATUS_VALUES)).min(1).max(PIPELINE_STATUS_VALUES.length).optional(),
        sort: sortArg,
        page: pageArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      repoSlug: repoSlugProp,
      branch: schema.string("Only runs targeting this branch (sent as target.branch)"),
      status: schema.array(
        schema.enumOf([...PIPELINE_STATUS_VALUES]),
        "One or more run statuses, ORed. PASSED is the filter spelling of a SUCCESSFUL result.",
        { minItems: 1, maxItems: PIPELINE_STATUS_VALUES.length }
      ),
      sort: schema.string("Default -created_on (newest first)"),
      page: pageProp,
      pagelen: pagelenProp,
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const res = await client.listPipelines(repoSlug, {
        branch: args.branch,
        status: args.status,
        sort: args.sort ?? DEFAULT_PIPELINE_SORT,
        page: args.page,
        pagelen: args.pagelen
      });
      // Echoed so an empty page can be told apart from an unfiltered one — but
      // only when something was actually filtered. An all-null object normalizes
      // to `{}`, which reads as "a filter was applied" and is worse than absent.
      const filters: Record<string, unknown> = {};
      if (args.branch) {
        filters.branch = args.branch;
      }
      if (args.status) {
        filters.status = [...args.status];
      }

      return ok({
        workspace: config.workspace,
        repoSlug,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        ...pageInfo(res),
        pipelines: (res.values ?? []).map((run) => normalizePipeline(run, config, repoSlug))
      });
    }
  });

  const getPipelineTool = defineTool({
    name: "get_pipeline",
    description:
      "Get one pipeline run by UUID (braces optional) or by build number — state, result, target branch/commit, trigger and duration.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        pipelineUuid: z.string().min(1).max(128),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      { repoSlug: repoSlugProp, pipelineUuid: pipelineRefProp, profile: profileProp },
      { required: ["pipelineUuid"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const ref = pipelineRefPath(args.pipelineUuid);
      const pipeline = await client.getPipeline(repoSlug, ref);
      return ok({ workspace: config.workspace, repoSlug, pipeline: normalizePipeline(pipeline, config, repoSlug) });
    }
  });

  const listPipelineStepsTool = defineTool({
    name: "list_pipeline_steps",
    description:
      "List the steps of one pipeline run with per-step state, result and duration — this is how you find which step failed, and the stepUuid to read its log.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        pipelineUuid: z.string().min(1).max(128),
        page: pageArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        pipelineUuid: pipelineRefProp,
        page: pageProp,
        pagelen: pagelenProp,
        profile: profileProp
      },
      { required: ["pipelineUuid"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const ref = pipelineRefPath(args.pipelineUuid);
      const res = await client.listPipelineSteps(repoSlug, ref, {
        page: args.page,
        pagelen: args.pagelen
      });
      return ok({
        workspace: config.workspace,
        repoSlug,
        pipeline: ref,
        ...pageInfo(res),
        steps: (res.values ?? []).map(normalizePipelineStep)
      });
    }
  });

  const getPipelineStepLogTool = defineTool({
    name: "get_pipeline_step_log",
    description:
      "Read the log of one pipeline step. Returns the LAST maxBytes bytes (default 256 KiB, max 1 MiB) because that is where a failure is. A step that has not started yet has no log and answers 404.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        pipelineUuid: z.string().min(1).max(128),
        stepUuid: z.string().min(1).max(128),
        maxBytes: z.number().int().positive().max(PIPELINE_LOG_MAX_BYTES).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        pipelineUuid: pipelineRefProp,
        stepUuid: stepUuidProp,
        maxBytes: schema.integer("Tail size in bytes (default 262144, max 1048576)", {
          minimum: 1,
          maximum: PIPELINE_LOG_MAX_BYTES
        }),
        profile: profileProp
      },
      { required: ["pipelineUuid", "stepUuid"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const ref = pipelineRefPath(args.pipelineUuid);
      const step = stepUuidPath(args.stepUuid);
      const maxBytes = args.maxBytes ?? PIPELINE_LOG_DEFAULT_BYTES;

      const { text: raw, partial } = await client.getPipelineStepLog(
        repoSlug,
        ref,
        step,
        maxBytes
      );
      // Two ways the log can be a tail: upstream honoured the Range (partial), or
      // it ignored it and sent everything, in which case the cut happens here.
      const { text, truncated } = shapeStepLog(raw, maxBytes, partial);

      return ok({
        workspace: config.workspace,
        repoSlug,
        pipeline: ref,
        stepUuid: step,
        tail: true,
        truncated,
        returnedBytes: Buffer.byteLength(text, "utf8"),
        log: text
      });
    }
  });

  return [listPipelinesTool, getPipelineTool, listPipelineStepsTool, getPipelineStepLogTool];
}

// --- reference normalization ------------------------------------------------

/**
 * Normalize a pipeline reference for use as a path segment: a UUID becomes the
 * braced form Bitbucket uses, a run of digits is taken as a build number, and
 * anything else is refused rather than sent upstream to 404.
 */
export function pipelineRefPath(raw: string): string {
  const core = stripBraces(raw);
  if (UUID_RE.test(core)) {
    return `{${core}}`;
  }
  if (/^\d+$/.test(core)) {
    return core;
  }
  throw new PolicyViolationError(
    "invalid_pipeline_ref",
    `"${raw}" is neither a pipeline UUID nor a build number. Pass the uuid from list_pipelines (braces optional) or the build number.`
  );
}

/** Same, for a step: a step is only ever addressed by UUID. */
export function stepUuidPath(raw: string): string {
  const core = stripBraces(raw);
  if (UUID_RE.test(core)) {
    return `{${core}}`;
  }
  throw new PolicyViolationError(
    "invalid_step_uuid",
    `"${raw}" is not a step UUID. Take stepUuid from list_pipeline_steps (braces optional).`
  );
}

function stripBraces(raw: string): string {
  return raw.trim().replace(/^\{/, "").replace(/\}$/, "");
}

// --- normalizers ------------------------------------------------------------

/**
 * `links.self.href` on a pipeline addresses the repo by UUID
 * (`/repositories/%7B0542…%7D/%7B5cf2…%7D/pipelines/%7B8d24…%7D`), which no
 * human can use. The browser URL is derivable from the build number, so it is
 * built here — but only for Bitbucket Cloud, since a non-default base URL means
 * the web host is unknown.
 */
function webUrlFor(
  config: BitbucketConfig,
  repoSlug: string,
  buildNumber: number | null
): string | null {
  if (buildNumber === null || !config.baseUrl.startsWith("https://api.bitbucket.org")) {
    return null;
  }
  return `https://bitbucket.org/${config.workspace}/${repoSlug}/pipelines/results/${String(buildNumber)}`;
}

function normalizePipeline(
  pipeline: Record<string, unknown>,
  config?: BitbucketConfig,
  repoSlug?: string
): Record<string, unknown> {
  const buildNumber = num(pipeline.build_number);
  return {
    uuid: str(pipeline.uuid),
    buildNumber,
    webUrl:
      config && repoSlug !== undefined ? webUrlFor(config, repoSlug, buildNumber) : null,
    state: str(get(pipeline, "state", "name")),
    result: str(get(pipeline, "state", "result", "name")),
    stage: str(get(pipeline, "state", "stage", "name")),
    refType: str(get(pipeline, "target", "ref_type")),
    refName: str(get(pipeline, "target", "ref_name")),
    commit: str(get(pipeline, "target", "commit", "hash")),
    trigger: str(get(pipeline, "trigger", "name")),
    creator: str(get(pipeline, "creator", "display_name")),
    createdOn: str(pipeline.created_on),
    completedOn: str(pipeline.completed_on),
    durationSeconds: num(pipeline.duration_in_seconds),
    href: str(get(pipeline, "links", "self", "href"))
  };
}

function normalizePipelineStep(step: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: str(step.uuid),
    name: str(step.name),
    state: str(get(step, "state", "name")),
    result: str(get(step, "state", "result", "name")),
    startedOn: str(step.started_on),
    completedOn: str(step.completed_on),
    durationSeconds: num(step.duration_in_seconds),
    image: str(get(step, "image", "name")),
    trigger: str(get(step, "trigger", "name"))
  };
}
