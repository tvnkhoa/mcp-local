/**
 * ENH-B — feature-bundle conventions.
 *
 * Encodes how a "vertical slice" feature is spread across well-known type names so
 * get_feature_bundle can gather the whole pattern (entity → EF config → commands/queries
 * + handlers/validators → endpoints) from a single seed, instead of the agent reading 6+
 * files by hand to absorb one convention. Name-pattern driven (resolved via
 * getSymbolCandidates) so adding a convention needs no walk-algorithm change.
 */

export type ConventionRole =
  | "entity"
  | "configuration"
  | "command"
  | "commandHandler"
  | "commandValidator"
  | "query"
  | "queryHandler"
  | "endpoint";

export type ConventionRule = {
  role: ConventionRole;
  /** Name templates with `{E}` (entity) / `{E_PLURAL}` placeholders. */
  namePatterns: string[];
};

export type Convention = {
  /** Suffixes stripped from a seed symbol name to recover the entity name. */
  entitySuffixes: string[];
  /** Leading verbs stripped from a seed symbol name (e.g. CreateOrderCommand → Order). */
  entityPrefixes: string[];
  rules: ConventionRule[];
};

export type ConventionName = "csharp-vertical-slice";

export const CONVENTIONS: Record<ConventionName, Convention> = {
  "csharp-vertical-slice": {
    entitySuffixes: [
      "Configuration",
      "CommandHandler",
      "CommandValidator",
      "Command",
      "QueryHandler",
      "QueryValidator",
      "Query",
      "EndpointGroup",
      "Endpoints",
      "Dto",
      "Handler",
      "Validator"
    ],
    entityPrefixes: ["Create", "Update", "Delete", "Get", "List", "Upsert", "Patch"],
    rules: [
      { role: "entity", namePatterns: ["{E}"] },
      { role: "configuration", namePatterns: ["{E}Configuration", "{E}EntityConfiguration"] },
      {
        role: "command",
        namePatterns: ["Create{E}Command", "Update{E}Command", "Delete{E}Command", "Upsert{E}Command"]
      },
      {
        role: "commandHandler",
        namePatterns: [
          "Create{E}CommandHandler",
          "Update{E}CommandHandler",
          "Delete{E}CommandHandler",
          "Upsert{E}CommandHandler"
        ]
      },
      {
        role: "commandValidator",
        namePatterns: ["Create{E}CommandValidator", "Update{E}CommandValidator", "Delete{E}CommandValidator"]
      },
      {
        role: "query",
        namePatterns: ["Get{E}Query", "Get{E}ByIdQuery", "Get{E_PLURAL}Query", "List{E}Query", "List{E_PLURAL}Query"]
      },
      {
        role: "queryHandler",
        namePatterns: ["Get{E}QueryHandler", "Get{E}ByIdQueryHandler", "Get{E_PLURAL}QueryHandler", "List{E_PLURAL}QueryHandler"]
      },
      { role: "endpoint", namePatterns: ["{E}Endpoints", "{E}EndpointGroup", "{E_PLURAL}Endpoints"] }
    ]
  }
};

/** Naive English pluralization good enough for type-name matching. */
export function pluralize(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + "ies";
  if (/(s|sh|ch|x|z)$/i.test(name)) return name + "es";
  return name + "s";
}

/** Recover the entity name from a seed symbol by stripping known role prefixes/suffixes. */
export function entityNameFromSeed(seed: string, convention: Convention): string {
  let name = seed;
  // Strip one matching suffix (longest first to avoid e.g. stripping "Handler" off "CommandHandler").
  const suffixes = [...convention.entitySuffixes].sort((a, b) => b.length - a.length);
  for (const suf of suffixes) {
    if (name.length > suf.length && name.endsWith(suf)) {
      name = name.slice(0, -suf.length);
      break;
    }
  }
  for (const pre of convention.entityPrefixes) {
    if (name.length > pre.length && name.startsWith(pre)) {
      name = name.slice(pre.length);
      break;
    }
  }
  return name;
}

/** Expand a rule's templates for a concrete entity name. */
export function expandPatterns(rule: ConventionRule, entity: string): string[] {
  const plural = pluralize(entity);
  return rule.namePatterns.map((p) => p.replace(/\{E_PLURAL\}/g, plural).replace(/\{E\}/g, entity));
}
