/**
 * Double-quote a SQL identifier, escaping any embedded double-quotes. This is the
 * single source of truth for dynamic identifier quoting across the server — it is a
 * security-relevant primitive (it is what stops a hostile schema/column/table name
 * from breaking out of the surrounding SQL), so it must not be re-implemented locally.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
