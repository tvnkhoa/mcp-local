# Architecture

What this workspace is, and why it is shaped that way.

| | |
|---|---|
| [As built](as-built.md) | The system as it actually is: four servers, six packages, and the three mechanisms that hold the shape |
| [Target architecture](target-architecture.md) | The design and its reasoning. **§9 reconciles the design against what was built** |

**Two files, deliberately.** `as-built.md` describes reality and is updated when reality changes.
`target-architecture.md` is the design record — a design document silently edited to match whatever
shipped stops being a design document.

## Related

- [Decisions](../decisions/README.md) — the three ADRs that constrain this architecture
- [Reference](../reference/README.md) — the tier matrix, the folder rules, and what each package is for
- [`archive/audit-report.md`](../archive/audit-report.md) — what the repository looked like before the migration
