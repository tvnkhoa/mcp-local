/**
 * MCP prompts.
 *
 * A prompt is a named, argument-taking message template a client can fetch and
 * hand to its model — the third protocol surface beside tools and resources.
 *
 * Same split as the other two: `createPrompt` builds protocol-free data and
 * validates it at construction time, `registerPrompt` composes many into one
 * provider, and `createServer` is the only place that knows this becomes
 * `prompts/list` and `prompts/get`. A server that declares no prompts does not
 * advertise the capability, so this file is inert until one does.
 */

import { validationError } from "@mcp/core";

import type { Entry } from "./collect.js";
import { flattenEntries, indexByName } from "./collect.js";

/** snake_case, must start with a letter — the same rule tools follow. */
const PROMPT_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export interface PromptArgument {
  readonly name: string;
  readonly description?: string;
  /** Absent or false: `render` must cope with the argument being missing. */
  readonly required?: boolean;
}

/**
 * One message in a rendered prompt.
 *
 * Text-only, deliberately: the protocol also admits image, audio and embedded
 * resource content, and none of the four servers has a use for them. Widening
 * this later is additive; narrowing it would not be.
 */
export interface PromptMessage {
  readonly role: "user" | "assistant";
  readonly content: { readonly type: "text"; readonly text: string };
}

export interface PromptResult {
  /** Overrides the declared description for this particular rendering. */
  readonly description?: string;
  readonly messages: readonly PromptMessage[];
}

/** What `prompts/list` advertises. */
export interface PromptDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly arguments?: readonly PromptArgument[];
}

export interface PromptDefinition {
  /** snake_case, stable forever — clients bind to it. */
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string;
  readonly arguments: readonly PromptArgument[];
  /**
   * Build the messages.
   *
   * Arguments arrive as the protocol delivers them: a flat string map. Every
   * argument declared `required` is guaranteed present by the time this runs —
   * see {@link createPrompt}.
   */
  render(args: Readonly<Record<string, string>>): PromptResult | Promise<PromptResult>;
}

export interface PromptProvider {
  /**
   * List what this server serves. `cursor` is the client's opaque page marker,
   * forwarded verbatim from `prompts/list`; a provider that answers in one page
   * ignores it. Same contract `ResourceProvider.list` has.
   */
  list(cursor?: string): readonly PromptDescriptor[] | Promise<readonly PromptDescriptor[]>;
  /**
   * Render one prompt. Return `undefined` for a name this provider does not
   * serve — the caller turns that into the protocol's "invalid params"
   * rejection, exactly as an unroutable resource URI is handled.
   */
  get(
    name: string,
    args: Readonly<Record<string, string>>
  ): PromptResult | undefined | Promise<PromptResult | undefined>;
}

export interface PromptSpec {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly arguments?: readonly PromptArgument[];
  readonly render: PromptDefinition["render"];
}

/**
 * Build one prompt.
 *
 * Validates the declaration at construction time — a malformed prompt is a
 * programmer error and fails at startup, not on first `prompts/get` — and
 * freezes the result, so nothing can mutate a prompt after registration. The
 * same contract `defineTool` has.
 *
 * The returned `render` also enforces the declared `required` arguments, which is
 * why the interface can promise they are present. The refusal is a
 * `validation_error` `PlatformError`; the protocol layer renders it as an
 * invalid-params rejection rather than an internal fault.
 */
export function createPrompt(spec: PromptSpec): PromptDefinition {
  if (!PROMPT_NAME_PATTERN.test(spec.name)) {
    throw new Error(`createPrompt: prompt name "${spec.name}" must be snake_case (e.g. "review_diff")`);
  }
  if (spec.description.trim() === "") {
    throw new Error(`createPrompt: prompt "${spec.name}" must have a non-empty description`);
  }

  const args = Object.freeze((spec.arguments ?? []).map((argument) => Object.freeze({ ...argument })));
  const seen = new Set<string>();
  for (const argument of args) {
    if (argument.name.trim() === "") {
      throw new Error(`createPrompt: prompt "${spec.name}" has an argument with an empty name`);
    }
    if (seen.has(argument.name)) {
      throw new Error(`createPrompt: prompt "${spec.name}" declares argument "${argument.name}" twice`);
    }
    seen.add(argument.name);
  }

  const required = args.filter((argument) => argument.required === true).map((argument) => argument.name);

  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    arguments: args,
    render(values: Readonly<Record<string, string>>) {
      const missing = required.filter((name) => values[name] === undefined);
      if (missing.length > 0) {
        throw validationError(
          `Prompt "${spec.name}" requires argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
        );
      }
      return spec.render(values);
    }
  });
}

/** Project a prompt definition onto the `prompts/list` shape. */
export function toPromptDescriptor(prompt: PromptDefinition): PromptDescriptor {
  return {
    name: prompt.name,
    ...(prompt.title === undefined ? {} : { title: prompt.title }),
    description: prompt.description,
    // Omitted rather than empty when there are none: an empty array is a claim
    // that the prompt takes arguments and happens to have zero.
    ...(prompt.arguments.length === 0 ? {} : { arguments: prompt.arguments })
  };
}

/**
 * Compose prompts into one provider.
 *
 * Entries may be single prompts or groups of them, so a server can pass its
 * per-domain lists straight through — the same shape `registerTool` and
 * `registerResource` accept. Duplicate names throw here rather than shadowing
 * silently.
 */
export function registerPrompt(prompts: readonly Entry<PromptDefinition>[]): PromptProvider {
  const byName = indexByName("registerPrompt", "prompt", flattenEntries(prompts));
  const descriptors = Object.freeze([...byName.values()].map(toPromptDescriptor));

  return {
    list: () => descriptors,
    get: (name, args) => byName.get(name)?.render(args)
  };
}
