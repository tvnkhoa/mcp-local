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
  list(): readonly ResourceDescriptor[] | Promise<readonly ResourceDescriptor[]>;
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
