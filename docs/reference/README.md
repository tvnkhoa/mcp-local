# Reference

Normative lookups. Each answers one question, and each names what enforces it.

| | Answers |
|---|---|
| [Conventions](conventions.md) | Every rule in the workspace, **sorted by whether something actually checks it** |
| [Folder convention](folder-convention.md) | Where does this file go? Plus the nine-slot server layout and the file-size caps |
| [Dependency rules](dependency-rules.md) | May this package import that one? The tier matrix and the ten rules |
| [Packages](packages.md) | What is each of the six packages for, and what must it never know? |

## The distinction that runs through all four

> A convention nobody checks is a preference.

Three hand-copied SQL guardrail implementations drifted apart in this repository precisely because the
rule against duplicating them was written down and not enforced — see
[ADR 0002](../decisions/0002-sql-guardrail-token-lists.md). So each rule in these pages states what
enforces it, and [Conventions](conventions.md) is organised by that distinction rather than by topic.

## Related

- [Decisions](../decisions/README.md) — why the rules are what they are
- [Architecture](../architecture/README.md) — the shape the rules protect
- `packages/cli/src/guards/rules.ts` — the tier matrix as data; if it and these pages disagree, the file is right
