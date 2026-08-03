# Development

Working in this repository: the loop, the gate, and what is left to do.

| | |
|---|---|
| [Workflow](workflow.md) | The day-to-day loop — prerequisites, build order, the script vocabulary, the test layers, the gate, and the two failures that cost an afternoon |
| [Continuous integration](ci.md) | What CI runs, what it deliberately does not (no live backends, no secrets), and the script vocabulary behind the root aggregates |
| [Backlog](backlog.md) | What is left, and what is explicitly *not* left |

## The gate, in one line

```bash
npm run verify:all     # packages + servers + tool contracts + generated docs. Credential-free.
```

Full expansion, and the two directions in which CI differs from it, are in [Workflow](workflow.md) §4.

## Related

- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — commits, review, and what a change has to carry
- [Reference › Conventions](../reference/conventions.md) — every rule, sorted by what enforces it
- [Servers](../servers/README.md) — adding or changing a server or a tool
