/**
 * One flattening rule for the three `register*` builders.
 *
 * Every server builds its surface as groups — a tool table assembled from five
 * `buildXTools()` calls, a resource set from two families. Each builder therefore
 * accepts a list whose entries may themselves be lists, so a server hands over
 * its groups without flattening at every call site, and `[...a, ...b, ...c]`
 * spreads stop appearing in five entry points.
 */

/** An entry in a `register*` argument: one definition, or a group of them. */
export type Entry<T> = T | readonly T[];

export function flattenEntries<T>(entries: readonly Entry<T>[]): T[] {
  const flat: T[] = [];
  for (const entry of entries) {
    if (Array.isArray(entry)) {
      flat.push(...(entry as readonly T[]));
    } else {
      flat.push(entry as T);
    }
  }
  return flat;
}

/**
 * Index definitions by name, refusing duplicates.
 *
 * A duplicate is a programmer error caught at construction: the alternative is
 * one definition silently shadowing another, which shows up as a tool that
 * cannot be called or a prompt that renders the wrong text.
 */
export function indexByName<T extends { readonly name: string }>(
  builder: string,
  kind: string,
  items: readonly T[]
): Map<string, T> {
  const byName = new Map<string, T>();
  for (const item of items) {
    if (byName.has(item.name)) {
      throw new Error(`${builder}: duplicate ${kind} name "${item.name}"`);
    }
    byName.set(item.name, item);
  }
  return byName;
}
