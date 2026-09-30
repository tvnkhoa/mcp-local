/**
 * Schemas this server creates and owns on every target database.
 *
 * `mcp_ops` holds the audit log today (`services/write/auditLog.ts`) and will hold the DDL
 * migration ledger. Two rules follow from owning it, and both read this list:
 *
 *  - It is not user schema. `captureSchema` leaves it out, otherwise the audit log creating
 *    `mcp_ops` on first use changes the snapshot id and a retried `migration_apply` fails with
 *    a `MIGRATION_DRIFT` that no migration caused (PG-MIG-005).
 *  - It is not writable through the tools. A ledger that `write_apply` can delete from records
 *    nothing (PG-SEC-002).
 */
export const INTERNAL_SCHEMAS: readonly string[] = ["mcp_ops"];

/**
 * Whether a schema name as it appears in SQL names an internal schema.
 *
 * Case-insensitive on purpose. An unquoted `MCP_OPS` folds to `mcp_ops`, so it must match; a
 * quoted `"MCP_OPS"` is a different schema, and refusing it too costs nothing legitimate.
 */
export function isInternalSchema(name: string): boolean {
  return INTERNAL_SCHEMAS.includes(name.toLowerCase());
}
