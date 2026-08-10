/**
 * One `ObserveClient` per configured environment, created on first use.
 *
 * The analogue of `postgres-mcp`'s `repositories/connectionManager.ts`, but living
 * in `services/` because that is where this server's HTTP client lives —
 * observe-mcp has no `repositories/` slot (see `docs/reference/folder-convention.md`).
 *
 * Every tool routes through `getClient(input.environment)` and reports
 * `resolveEnvName(input.environment)` back to the caller, so a response always
 * names the environment that answered it — including when the argument was
 * omitted and the default applied.
 */

import { assertEnvironment, buildEnvironmentRegistry, canonicalEnvName, maskEnvironment } from "../config/environments.js";
import type { EnvironmentRegistry, ObserveEnvironment } from "../config/environments.js";
import type { ObserveLimits } from "../config/index.js";

import { ObserveClient } from "./observeClient.js";

/** How a client is built for an environment. Overridable so tests can stub the network. */
export type ClientFactory = (environment: ObserveEnvironment, limits: ObserveLimits) => ObserveClient;

const defaultClientFactory: ClientFactory = (environment, limits) => new ObserveClient({ environment, limits });

export class ClientManager {
  private readonly limits: ObserveLimits;
  private readonly registry: EnvironmentRegistry;
  private readonly createClient: ClientFactory;
  private readonly clients = new Map<string, ObserveClient>();

  /**
   * `registry` is injectable so tests can build one without touching
   * `process.env`, and `createClient` so they can do it without touching the
   * network — the tool-contract suite asserts on responses, not on HTTP.
   */
  constructor(limits: ObserveLimits, registry?: EnvironmentRegistry, createClient: ClientFactory = defaultClientFactory) {
    this.limits = limits;
    this.registry = registry ?? buildEnvironmentRegistry();
    this.createClient = createClient;
  }

  get defaultEnvironment(): string {
    return this.registry.defaultEnvironment;
  }

  /**
   * Canonicalize BEFORE the lookup, not after. Without this, `"Prod"` would miss
   * the map and fail as `unknown_environment` even though `prod` is configured.
   */
  resolveEnvName(name?: string): string {
    return name && name.trim().length > 0 ? canonicalEnvName(name) : this.registry.defaultEnvironment;
  }

  getEnvironment(name?: string): ObserveEnvironment {
    return assertEnvironment(this.registry, this.resolveEnvName(name));
  }

  /**
   * Memoized per environment, and lazy so configuring five environments does not
   * build five HTTP clients at boot.
   *
   * Lazy client construction is NOT lazy credential validation: `buildEnvironmentRegistry`
   * calls `resolveAuthHeader` for every environment while building the registry, so
   * an environment with missing or half-written credentials throws at STARTUP, not
   * on first query. That is deliberate — a credential typo should fail the boot the
   * operator is watching, not the query someone runs a week later — and it is worth
   * stating here, because this is where a boot failure gets looked for and is not.
   */
  getClient(name?: string): ObserveClient {
    const env = this.getEnvironment(name);
    let client = this.clients.get(env.name);
    if (!client) {
      client = this.createClient(env, this.limits);
      this.clients.set(env.name, client);
    }
    return client;
  }

  /** Every environment, credential-free, for `list_environments` and the startup log. */
  list(): ReturnType<typeof maskEnvironment>[] {
    return [...this.registry.environments.values()].map((env) =>
      maskEnvironment(env, env.name === this.registry.defaultEnvironment)
    );
  }
}
