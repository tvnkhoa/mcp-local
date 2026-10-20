import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ownerMatchesSection, registryEntries, reverseReport, schemaKeys, sectionStem } from "./termLookup.js";

const REGISTRY = [
  "# 10 — Canonical model",
  "",
  "### 3.7 Turn",
  "",
  "| Field | Type | Notes |",
  "|---|---|---|",
  "| `citations` | array | `kb_version_ids` in the payload is this list projected |",
  "",
  "### 3.13 Audit event",
  "",
  "| Field | Type | Notes |",
  "|---|---|---|",
  "| `kb_version_ids` | array | A list, never a scalar |",
  "",
  "```ts",
  "kb_version_ids: z.array(z.string())",
  "```",
  "tool_names is described in prose only."
];

const CONTRACT = [
  "import { z } from 'zod'",
  "const audit_event_common_fields = {",
  "  // kb_version_ids: z.number() in a comment line is not a key",
  "  kb_version_ids: z.array(z.string()),",
  "  tool_names: z.array(z.string()),",
  "  staff_user_id:",
  "    z.string().nullable(),",
  "  plain: 'not a schema',",
  "}",
  "export const audit_event_schema = z.object({",
  "  ...audit_event_common_fields,",
  "  kind: audit_kind_schema,",
  "})"
].join("\n");

describe("termLookup", () => {
  it("separates the defining table row from mentions, skipping fenced code", () => {
    const r = registryEntries(REGISTRY, "kb_version_ids", 10);
    assert.equal(r.definitions.length, 1);
    assert.equal(r.definitions[0]!.line, 13);
    assert.equal(r.definitions[0]!.section, "3.13 Audit event");
    assert.deepEqual(r.mentions.map((m) => m.line), [7]);
    assert.equal(r.mentionCount, 1);
  });

  it("finds Zod shape keys with their owner, following a value on the next line", () => {
    const keys = schemaKeys(CONTRACT, "contracts/audit.ts");
    assert.deepEqual(keys.map((k) => [k.key, k.line, k.owner]), [
      ["kb_version_ids", 4, "audit_event_common_fields"],
      ["tool_names", 5, "audit_event_common_fields"],
      ["staff_user_id", 6, "audit_event_common_fields"],
      ["kind", 12, "audit_event_schema"]
    ]);
    assert.deepEqual(schemaKeys("const x = { a_b: z.string() }", "f.ts"), [], "no zod import, no keys");
  });

  it("links an owner to the registry entity it is named after", () => {
    assert.equal(sectionStem("3.13 Audit event"), "audit_event");
    assert.equal(ownerMatchesSection("audit_event_common_fields", "3.13 Audit event"), true);
    assert.equal(ownerMatchesSection("turn_schema", "3.13 Audit event"), false);
  });

  it("recognises the four definition shapes wec.aria's registry uses", () => {
    const reg = [
      "### 3.68 Usage summary",
      "| Field | Type | Notes |",
      "|---|---|---|",
      "| `proposed_by`, `proposed_by_username` | string, string \\| null | who |",
      "| `periods` | array | Every period: `period_start`, `period_end` (exclusive) |",
      "| `documents` | array | `{ document_id, then_version_id }` |",
      "### 4.12 `task_type`",
      "`vehicles_truncated` is a boolean and is the only name this section mints.",
      "hard_gate_reasons appears bare."
    ];
    const kind = (k: string) => registryEntries(reg, k, 5).definitions[0]?.definedBy;
    assert.equal(kind("proposed_username") ?? null, null);
    assert.equal(kind("proposed_by_username"), "row");
    assert.equal(kind("proposed_by"), "row");
    assert.equal(kind("period_end"), "nested");
    assert.equal(kind("then_version_id"), "nested");
    assert.equal(kind("task_type"), "heading");
    assert.equal(kind("vehicles_truncated"), "prose");
    assert.equal(kind("hard_gate_reasons") ?? null, null);

    const src = [
      "import { z } from 'zod'",
      "export const handover_schema = z.object({",
      "  aria_did: z.string(),",
      "  wants: z.string(),",
      "  json_schema: z.string(),",
      "})",
      "export const plain_schema = z.object({",
      "  kind: z.string(),",
      "})"
    ].join("\n");
    const rep = reverseReport(schemaKeys(src, "core/summarise.ts"), reg, ["json_schema"]);
    assert.deepEqual(rep.missing.map((m) => m.key), ["aria_did", "wants"], "wants is scanned beside aria_did; kind (no snake key in its schema) is not; json_schema is ignored");
    assert.equal(rep.ignored, 1);
  });

  it("reverse report: snake_case keys with no defining row, never-named first", () => {
    const rep = reverseReport(schemaKeys(CONTRACT, "contracts/audit.ts"), REGISTRY);
    assert.equal(rep.keysScanned, 3, "kind is not snake_case with an underscore");
    assert.deepEqual(rep.defined, { row: 1, heading: 0, nested: 0, prose: 0 });
    assert.deepEqual(rep.missing.map((m) => [m.key, m.confidence]), [["staff_user_id", "high"], ["tool_names", "medium"]]);
  });
});
