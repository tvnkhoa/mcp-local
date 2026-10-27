## MCP-ISSUE-037 — abstract/virtual base-class members have no dispatch fan-out, so every override looks dead

- **Status:** **FIXED** 2026-07-30, in two parts — see the update at the end. Found while verifying
  MCP-ISSUE-036: after two false-positive causes were removed, this is what the remaining `dead_code_scan`
  candidates turned out to be.
- **Scenario:** a template-method base class. `SentMessageConsumerBase<TContract>` declares
  `protected abstract SentMessageInfo GetMessageInfo(TContract)` and calls it; `AutomationSentConsumer` and
  `CampaignSentConsumer` each `override` it.
- **Evidence:**

  | symbol | signature | incoming CALLS |
  |---|---|---|
  | `SentMessageConsumerBase.GetMessageInfo` | `protected abstract` | 1 |
  | `AutomationSentConsumer.GetMessageInfo` | `protected override` | **0** |
  | `CampaignSentConsumer.GetMessageInfo` | `protected override` | **0** |

  Same for `BuildCommand`, `LogProcessed`, `LogDuplicate`. The base's own call resolves to the base's
  abstract declaration and stops there.
- **Why the existing machinery does not cover it:** interface dispatch IS handled — a call to an interface
  method fans out to implementors as `interface-dispatch` CALLS edges, capped by
  `MAX_INTERFACE_DISPATCH_FANOUT`. The identical relationship through an abstract *class* has no
  equivalent, and cannot be given one as things stand, because **class inheritance is not recorded as a
  traversable relation at all.** `IMPLEMENTS` is only emitted for base-list entries passing
  `isLikelyCSharpInterfaceName`, so `class X : SomeBaseClass` yields nothing; verified on
  `AutomationSentConsumer`, which has zero IMPLEMENTS edges and only a `TYPE_REF` to its base — and a
  TYPE_REF carries no "extends" meaning, so nothing can walk it as a hierarchy.
- **Impact:** every `override` of an abstract or virtual member is a `dead_code_scan` false positive, and
  `find_implementations` / `get_call_chain` cannot follow a template-method hierarchy. The template-method
  pattern is common in this codebase's consumer lane, so the false positives cluster and look like a
  systematic finding rather than noise.
- **Shape of a fix (two parts, in order):** emit an inheritance edge for a non-interface base type — either
  a distinct `EXTENDS` type or `IMPLEMENTS` with a reason that distinguishes it, and the choice matters
  because several tools already read `IMPLEMENTS` as "interface contract". Then reuse the existing
  dispatch fan-out, keyed on that edge, for members marked `abstract` or `virtual`.
- **Workaround until then:** treat a candidate whose signature contains `override` as suppressed. Note that
  `dead_code_scan` does not currently do this — the signature is already stored, so it is a cheap interim
  guard if the full fix is deferred.

### Update 2026-07-30 — FIXED as two mechanisms, because the candidates are two populations

The entry above treated this as one problem. It is not, and building only the dispatch half would have left
half the false positives standing:

1. **Overriding an in-repo abstract/virtual member** — fixable, and now fixed by `EXTENDS` + fan-out.
2. **Overriding an EXTERNAL virtual member** — `Equals`, `GetHashCode`, `ToString`, `Dispose`,
   `OnModelCreating`. The caller is the BCL or a framework, so no in-repo edge can ever exist. No amount of
   inheritance modelling reaches these; suppression is the correct permanent answer.

**Part 1 — `heuristic_override_member` suppression.** `dead_code_scan` already models "I cannot tell" as
suppression, with `scanPolicy.note` stating that exclusion does not prove a symbol live — exactly the claim
being made. So the honest fix for the second population was a suppression reason, not an edge. Cost, stated:
a genuinely dead override inside a dead subclass is now hidden.

**Part 2 — `EXTENDS` + `base-class-dispatch`.** A distinct edge type rather than reusing `IMPLEMENTS`,
because C# allows one base class and many interfaces, and several tools read `IMPLEMENTS` as "satisfies an
interface contract" — folding them would make "how many interfaces does this implement" answer wrong without
changing its shape. `base:Name` tokens resolve in `resolveExtendsEdges`; unresolvable ones (ControllerBase,
DbContext) are tagged `external boundary`, as unresolvable interfaces already are.

**Two things this got wrong first, both worth recording:**

- **The fan-out was in the wrong phase.** It started inside `resolveCallEdgesBatch`, beside interface
  dispatch, and produced nothing. The template-method shape has the base calling its own abstract member *in
  the same file*, so `resolveIntraFileEdges` links it at EXTRACTION time and the edge never reaches the
  unresolved-token lane the batch resolver iterates. Hooking into that lane misses exactly the case this
  exists for. It is now its own pass over FINAL CALLS edges, covering both shapes without caring which phase
  created the edge.
- **An early return disabled the whole thing.** `if (localMethods.size === 0) return` was correct for the
  method-group branch it was written for and catastrophic beside this one: a FluentValidation validator is
  usually a class whose only member is a constructor. Only a test whose fixture also had no
  `method_declaration` caught it — a fixture with one incidental method would have passed and proven nothing.

**The gate that makes it safe:** only `abstract` and `virtual` members fan out, read off the stored
signature. A non-virtual base method is never overridden, so a same-named subclass method is a `new`/shadow —
a different method — and reaching it would attribute a call to code that cannot run. For `dead_code_scan` a
false "live" hides real dead code, the one direction of error it cannot afford.

**Measured on `wec.communication-hub`:** 136 override false positives suppressed, of which **12 are now
genuinely reachable** through dispatch rather than merely suppressed (matching 12 `base-class-dispatch`
edges). `EXTENDS` = 157. On `wec.be`: `EXTENDS` = 3796, 19 dispatch edges. The remaining 124 suppressions are
the external-override population, where suppression is the answer rather than a placeholder.

Covered by `test:base-class-dispatch`, 8 cases — three of them NEGATIVE, since the failure mode that matters
is over-reaching: a shadow method, a same-named method outside the hierarchy, and the base keeping its own
direct call (the fan-out must ADD reachability, not move it).

---

