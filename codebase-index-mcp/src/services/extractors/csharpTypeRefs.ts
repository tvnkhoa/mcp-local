/**
 * TYPE_REF edges for C# type positions that appear inside method BODIES and on declarations —
 * the second half of MCP-ISSUE-034.
 *
 * The first half covered signatures: base lists, return types, parameters, fields, properties. Those
 * are where a type is *declared*, and fixing them took TYPE_REF from 148 edges to a few thousand. But a
 * type can be used without appearing in any signature, and every such position emitted nothing:
 *
 *     var a = new Order();                      // no edge
 *     JsonSerializer.Deserialize<OrderDto>(s);  // no edge
 *     OrderHelper.Compute();                    // no edge
 *     if (o is Customer c) { }                  // no edge
 *     catch (DomainException e) { }             // no edge
 *
 * A DTO constructed in one place and never named in a signature therefore had no incoming TYPE_REF at
 * all, and `dead_code_scan` reported it dead — correctly by its own rule, over a relation that was still
 * missing most of the truth.
 *
 * Node types and field names here were read off the grammar rather than assumed; several are not what
 * the C# source shape suggests (`as` is `as_expression` with `left`/`right`, not a `type` field; pattern
 * matching goes through `is_pattern_expression` -> `declaration_pattern`).
 */

import type Parser from "tree-sitter";
import type { EdgeRecord } from "../types.js";
import type { ExtractInput } from "./extractorTypes.js";
import { emitTypeRefEdgesFromTypeNode, findEnclosingCSharpSymbolId } from "./extractorUtils.js";

/**
 * Static receivers that are BCL or ubiquitous framework types. A TYPE_REF to one of these can never
 * resolve to a repo symbol.
 *
 * Filtering at extraction rather than leaving it to the resolver is deliberate, and the cost is
 * measured: MCP-ISSUE-034's first half raised unresolved TYPE_REF rows from 110 to ~3200, and because
 * every one of them falls through to the expensive cross-repo and vector fallbacks, `typeResolveMs` on
 * `wec.communication-hub` went from 5214 to 111950. That was fixed by memoizing per name, but the
 * cheapest unresolvable edge is still the one never created — and `Console`, `Math` and `Task` are
 * exactly the names that repeat most.
 *
 * Names only, not namespaces: a repo type genuinely called `Result` or `Error` must still be recorded,
 * so this list stays limited to types whose BCL meaning is unambiguous in a static-receiver position.
 */
const CSHARP_BCL_STATIC_RECEIVERS = new Set([
  "Console", "Math", "String", "Convert", "Buffer", "Array", "Enum", "Type", "Nullable", "Tuple",
  "File", "Directory", "Path", "FileInfo", "DirectoryInfo", "Stream", "Encoding",
  "Task", "Thread", "Interlocked", "Monitor", "Volatile", "Parallel", "Timeout",
  "Guid", "DateTime", "DateTimeOffset", "TimeSpan", "TimeZoneInfo", "DateOnly", "TimeOnly",
  "Regex", "JsonSerializer", "JsonConvert", "Encoding64",
  "Environment", "Activator", "Assembly", "AppDomain", "AppContext", "GC",
  "CultureInfo", "Uri", "Random", "Stopwatch", "Process", "Debug", "Trace", "Debugger",
  "Enumerable", "Queryable", "Comparer", "EqualityComparer", "StringComparer", "StringComparison",
  "BitConverter", "Interop", "Marshal", "Unsafe", "Span", "Memory",
  // Serilog's static logger and the two most common DI/host statics.
  "Log", "Host", "WebApplication",
]);

/** Node types whose `type` field is a type position, handled identically. */
const TYPE_FIELD_NODES = [
  "object_creation_expression", // new Order()  /  new Repo<Order>()
  "typeof_expression", //          typeof(Order)
  "cast_expression", //            (Invoice)o
  "default_expression", //         default(Money)
  "catch_declaration", //          catch (DomainException e)
  "declaration_pattern", //        o is Customer c      (reached via is_pattern_expression)
  "variable_declaration", //       Order local = null;  (`var` is implicit_type and yields nothing)
  "sizeof_expression",
] as const;

export function extractCSharpBodyTypeRefs(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  const owner = (node: Parser.SyntaxNode): string =>
    findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;

  for (const node of root.descendantsOfType([...TYPE_FIELD_NODES])) {
    emitTypeRefEdgesFromTypeNode(input, owner(node), node.childForFieldName("type"), edges);
  }

  // `o as Vendor` — no `type` field; the type is the right operand.
  for (const node of root.descendantsOfType(["as_expression"])) {
    emitTypeRefEdgesFromTypeNode(input, owner(node), node.childForFieldName("right"), edges);
  }

  // `[Authorize]`, `[Route("x")]`. C# resolves these to `AuthorizeAttribute`, so the bare name only
  // matches a repo type declared without the suffix — recorded anyway, since a custom attribute IS a
  // reference and the alternative is recording nothing.
  for (const node of root.descendantsOfType(["attribute"])) {
    emitTypeRefEdgesFromTypeNode(input, owner(node), node.childForFieldName("name"), edges);
  }

  // `where T : IAggregate` — the clause has no named fields, so walk its constraints.
  for (const node of root.descendantsOfType(["type_parameter_constraint"])) {
    for (const child of node.namedChildren) {
      emitTypeRefEdgesFromTypeNode(input, owner(node), child, edges);
    }
  }

  for (const node of root.descendantsOfType(["invocation_expression"])) {
    const fn = node.childForFieldName("function");
    if (!fn) continue;

    // Generic ARGUMENTS of the call, not the method name. `JsonSerializer.Deserialize<OrderDto>(s)`
    // references OrderDto; `Deserialize` is a method and emitting it as a type would be wrong, so
    // `collectTypeNames` cannot be pointed at the generic_name as a whole (it would take the base name
    // too).
    const nameNode = fn.type === "member_access_expression" ? fn.childForFieldName("name") : fn;
    if (nameNode?.type === "generic_name") {
      const args =
        nameNode.childForFieldName("type_arguments") ??
        nameNode.namedChildren.find((c) => c.type === "type_argument_list");
      for (const arg of args?.namedChildren ?? []) {
        emitTypeRefEdgesFromTypeNode(input, owner(node), arg, edges);
      }
    }
  }

  // `o is Customer` and `x switch { Order => ... }` with no bound variable.
  //
  // The grammar gives `constant_pattern`, which it also uses for genuine constants (`o is 5`,
  // `o is null`, `o is Status.Active`). A bare PascalCase identifier in that position is a type far more
  // often than a const, so it is emitted; `Status.Active` is a member_access and does not reach here, and
  // a literal is not an identifier. The residual false positive is a screaming-case const used as a
  // pattern, which costs one unresolvable edge.
  for (const node of root.descendantsOfType(["constant_pattern"])) {
    const only = node.namedChildren.length === 1 ? node.namedChildren[0] : null;
    if (only?.type !== "identifier") continue;
    if (!/^[A-Z]/.test(only.text.trim())) continue;
    emitTypeRefEdgesFromTypeNode(input, owner(node), only, edges);
  }

  emitMethodGroupCalls(input, root, edges, moduleSymbolId);

  // Static member access: `OrderHelper.Compute()`, `OrderConstants.MaxItems`.
  //
  // The receiver is a TYPE here, not a value, and it was invisible to the graph: the existing lane emits
  // a `callee:OrderHelper.Compute` CALLS edge, but `dead_code_scan` tests `to_id = 'callee:' || name`,
  // which never matches the dotted form — so a static helper class called from twenty places still read
  // as having no incoming reference.
  //
  // Restricted to PascalCase receivers because C# convention makes lowercase receivers locals and
  // fields. Instance access through a PascalCase property is misread as a type here; that costs an
  // unresolvable edge, whereas the reverse error loses a real reference.
  for (const node of root.descendantsOfType(["member_access_expression"])) {
    const receiver = node.childForFieldName("expression");
    if (receiver?.type !== "identifier") continue;
    const name = receiver.text.trim();
    if (!/^[A-Z]/.test(name) || CSHARP_BCL_STATIC_RECEIVERS.has(name)) continue;
    emitTypeRefEdgesFromTypeNode(input, owner(node), receiver, edges);
  }
}

/**
 * A method passed as a delegate rather than called: `RuleFor(x => x.Data).Must(BeValidBase64)`.
 *
 * The method IS invoked — by the validator, at runtime — but no `invocation_expression` names it, so no
 * CALLS edge existed and `dead_code_scan` reported it dead. FluentValidation makes this common enough to
 * matter; so do `Select(Map)`, `Where(IsActive)` and event handler registration.
 *
 * Scoped tightly on purpose: the argument must be a BARE identifier that matches a method declared in
 * THIS FILE. A bare identifier argument is usually a variable, so without the same-file method check the
 * false-positive rate would be unacceptable — and a spurious CALLS edge is worse than a missing one,
 * since it makes a dead symbol look live.
 */
function emitMethodGroupCalls(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Only the bare-identifier branch below consults this. There is deliberately NO early return when it
  // is empty: a FluentValidation validator is typically a class whose only member is a constructor, so
  // `localMethods` is empty in exactly the files that carry the qualified method groups this also handles.
  // An early return here silently disabled the qualified case on every real call site, and only a test
  // whose fixture had no method_declaration caught it.
  const localMethods = new Set<string>();
  for (const decl of root.descendantsOfType(["method_declaration", "local_function_statement"])) {
    const name = decl.childForFieldName("name")?.text?.trim();
    if (name) localMethods.add(name);
  }

  for (const call of root.descendantsOfType(["invocation_expression"])) {
    const args = call.childForFieldName("arguments");
    for (const arg of args?.namedChildren ?? []) {
      // `argument` wraps the expression; a bare method group is a lone identifier inside it.
      const expr = arg.type === "argument" ? arg.namedChildren[0] : arg;
      if (!expr) continue;
      const fromId = findEnclosingCSharpSymbolId(call, input) ?? moduleSymbolId;

      if (expr.type === "identifier") {
        const name = expr.text.trim();
        if (!localMethods.has(name)) continue;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${name}`,
          type: "CALLS",
          confidence: 0.7,
          reason: "method group reference"
        });
        continue;
      }

      // The QUALIFIED form, `Must(EmailReplyAttachmentRules.BeValidBase64)`, which is how this is
      // actually written when the helper lives in another class — and it is the case that motivated the
      // whole method-group rule, yet the same-file identifier check above cannot see it. Verified against
      // the real repo: three `EmailReplyAttachmentRules` helpers were still reported dead after the first
      // pass shipped, because every call site is in a different file and uses this form.
      //
      // Emitted as the QUALIFIED token ONLY, never also as `callee:Member`, and that is what makes it
      // safe. The same shape covers a static CONSTANT passed as an argument —
      // `MaximumLength(EmailReplyAttachmentRules.MaxInlineAttachmentBase64CharsPerFile)` sits four lines
      // away in that same file — and extraction cannot tell a static method from a static const without
      // cross-file knowledge. A bare `callee:Member` token would be counted as a reference by
      // `dead_code_scan` even unresolved (it tests `to_id = 'callee:' || name`), so a const would make a
      // same-named method look live. The qualified token is not counted unless the resolver rewrites it
      // to a real method symbolId — so a const simply fails to resolve and contributes nothing.
      //
      // For dead_code_scan the direction of the error matters: a false "live" hides real dead code and
      // costs the tool its credibility, while a false "dead" is a candidate a human dismisses.
      if (expr.type === "member_access_expression") {
        const receiver = expr.childForFieldName("expression");
        const member = expr.childForFieldName("name");
        if (receiver?.type !== "identifier" || member?.type !== "identifier") continue;
        const receiverName = receiver.text.trim();
        // PascalCase receiver = a type, so this is a static member group. A lowercase receiver is a local
        // or field, and `x.SomeProperty` is a value being passed, not a method being referenced.
        if (!/^[A-Z]/.test(receiverName) || CSHARP_BCL_STATIC_RECEIVERS.has(receiverName)) continue;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${receiverName}.${member.text.trim()}`,
          type: "CALLS",
          confidence: 0.7,
          reason: "method group reference"
        });
      }
    }
  }
}
