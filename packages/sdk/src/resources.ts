/**
 * MCP resources.
 *
 * A resource is read-addressable state a client can fetch by URI instead of
 * calling a tool — postgres-mcp exposes each environment's schema as
 * `schema://<env>` so a client reads structure once rather than repeating
 * `describe_table`.
 *
 * The provider interface is deliberately protocol-free: a server describes what
 * it has and how to read one, and `createMcpServer` is the only place that knows
 * this becomes `resources/list` and `resources/read`. Same split as tools.
 */

import type { Entry } from "./collect.js";
import { flattenEntries, indexByName } from "./collect.js";

export interface ResourceDescriptor {
  /** Stable URI a client passes back to read this resource. */
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

export interface ResourceProvider {
  /**
   * List what this server serves.
   *
   * `cursor` is the client's opaque page marker, forwarded verbatim from
   * `resources/list`. A provider that returns every descriptor in one page ignores
   * it — declaring the parameter is optional, so an existing zero-argument
   * provider stays valid. It exists because the alternative is worse than an
   * unused parameter: an interface with no cursor at all silently discards
   * whatever the server used to do with one, and codebase-index-mcp answers a
   * cursored request with an empty page. That behaviour survives only if the
   * value reaches the provider.
   */
  list(cursor?: string): readonly ResourceDescriptor[] | Promise<readonly ResourceDescriptor[]>;
  /**
   * Read one resource.
   *
   * Return `undefined` for a URI this provider does not serve — the caller turns
   * that into the protocol's "invalid params" rejection. Returning a sentinel
   * rather than throwing keeps the provider free of protocol error types; any
   * error it *does* throw propagates unchanged, so a genuine read failure stays
   * distinguishable from an unroutable URI.
   */
  read(
    uri: string
  ):
    | readonly ResourceContent[]
    | undefined
    | Promise<readonly ResourceContent[] | undefined>;
}

/**
 * One resource, or one family of them.
 *
 * Structurally a provider that serves a single URI shape, which is what lets
 * `registerResource` compose several into the one provider a server hands to
 * `createServer` — and what lets a server pass a hand-written provider wherever a
 * definition is expected.
 */
export interface ResourceDefinition extends ResourceProvider {
  /** Internal identifier. Appears in duplicate-registration errors, not on the wire. */
  readonly name: string;
}

export interface ResourceReadContext<P> {
  readonly uri: string;
  /** Whatever `match` extracted. `{}` for a static `uri` resource. */
  readonly params: P;
}

interface ResourceSpecBase {
  readonly name: string;
  readonly description?: string;
  /** Applied to both the descriptor and the content. Default `application/json`. */
  readonly mimeType?: string;
  /**
   * Payload → text. Default: minified JSON.
   *
   * The one knob worth having, because the two existing providers disagree:
   * postgres-mcp minifies its schema snapshot, codebase-index-mcp pretty-prints
   * with two-space indent, and both shapes are already what clients receive.
   */
  readonly serialize?: (payload: unknown) => string;
}

/** A resource at one fixed URI. */
export interface StaticResourceSpec extends ResourceSpecBase {
  readonly uri: string;
  /** Human-facing name for `resources/list`. Defaults to `name`. */
  readonly title?: string;
  readonly read: (context: ResourceReadContext<Record<string, never>>) => unknown | Promise<unknown>;
}

/**
 * A family of resources sharing a URI shape.
 *
 * Routing is the server's own `match` rather than a template language: both
 * existing providers parse more than path segments — a percent-encoded repoId, a
 * case-insensitive kind, a clamped `?limit=` — and a URI parser that handles that
 * is the server's contract, not platform boilerplate. What the builder absorbs is
 * everything around it: the descriptor shape, the mime type, serialization, and
 * the not-my-URI contract.
 */
export interface MatchedResourceSpec<P> extends ResourceSpecBase {
  /** Return the parsed parts, or `undefined`/`null` when the URI is not this family's. */
  readonly match: (uri: string) => P | undefined | null;
  /**
   * Enumerate the instances that exist right now.
   *
   * Required, because a family cannot be enumerated from its URI shape. Return
   * `[]` for a family that is readable but deliberately unadvertised.
   */
  readonly list: (cursor?: string) => readonly ResourceDescriptor[] | Promise<readonly ResourceDescriptor[]>;
  readonly read: (context: ResourceReadContext<P>) => unknown | Promise<unknown>;
}

const DEFAULT_MIME_TYPE = "application/json";

/**
 * Build one resource, or one family.
 *
 * The read path is: route the URI → read the payload → serialize → wrap as
 * content. A resource that does not route the URI yields `undefined`, which
 * `createServer` turns into the protocol's invalid-params rejection. Anything the
 * spec's own `match` or `read` throws propagates untouched, so a server that
 * prefers its own error for an unroutable URI keeps raising it.
 */
export function createResource(spec: StaticResourceSpec): ResourceDefinition;
export function createResource<P>(spec: MatchedResourceSpec<P>): ResourceDefinition;
export function createResource<P>(
  spec: StaticResourceSpec | MatchedResourceSpec<P>
): ResourceDefinition {
  if (spec.name.trim() === "") {
    throw new Error("createResource: name must be non-empty");
  }
  const mimeType = spec.mimeType ?? DEFAULT_MIME_TYPE;
  const serialize = spec.serialize ?? ((payload: unknown) => JSON.stringify(payload));

  const toContents = (uri: string, payload: unknown): readonly ResourceContent[] => [
    { uri, mimeType, text: serialize(payload) }
  ];

  if ("uri" in spec) {
    const descriptor: ResourceDescriptor = {
      uri: spec.uri,
      name: spec.title ?? spec.name,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      mimeType
    };
    return Object.freeze({
      name: spec.name,
      list: () => [descriptor],
      read: async (uri: string) =>
        uri === spec.uri ? toContents(uri, await spec.read({ uri, params: {} })) : undefined
    });
  }

  return Object.freeze({
    name: spec.name,
    list: (cursor?: string) => spec.list(cursor),
    read: async (uri: string) => {
      const params = spec.match(uri);
      if (params === undefined || params === null) {
        return undefined;
      }
      return toContents(uri, await spec.read({ uri, params }));
    }
  });
}

export interface RegisterResourceOptions {
  /**
   * Answer a cursored `resources/list` with an empty page instead of forwarding
   * the cursor. For a server whose descriptors all fit one page, this is how it
   * says so — and it is what codebase-index-mcp has always done.
   *
   * Default false: the cursor reaches each definition's `list`, so a definition
   * that pages can.
   */
  readonly emptyOnCursor?: boolean;
  /**
   * Answer a URI no definition routes.
   *
   * Default: return `undefined`, which becomes the platform's invalid-params
   * rejection. A server that already publishes its own message for an unroutable
   * URI — and codebase-index-mcp does, naming the URI grammar in it — throws that
   * error here instead, so adopting the builder does not rewrite it.
   */
  readonly onUnmatched?: (uri: string) => readonly ResourceContent[] | undefined;
}

/**
 * Compose resources into the one provider `createServer` takes.
 *
 * `list` concatenates every definition's descriptors in declaration order.
 * `read` tries each definition in that same order and returns the first that
 * routes the URI, so ordering is the disambiguation rule when two families could
 * both match. Nothing matched means `undefined`, which becomes invalid-params.
 */
export function registerResource(
  resources: readonly Entry<ResourceDefinition>[],
  options: RegisterResourceOptions = {}
): ResourceProvider {
  const flat = flattenEntries(resources);
  // Indexed for the duplicate check only — routing is ordered, not by name.
  indexByName("registerResource", "resource", flat);

  return {
    async list(cursor) {
      if (options.emptyOnCursor === true && cursor !== undefined) {
        return [];
      }
      const descriptors: ResourceDescriptor[] = [];
      for (const resource of flat) {
        descriptors.push(...(await resource.list(cursor)));
      }
      return descriptors;
    },

    async read(uri) {
      for (const resource of flat) {
        const contents = await resource.read(uri);
        if (contents !== undefined) {
          return contents;
        }
      }
      return options.onUnmatched?.(uri);
    }
  };
}
