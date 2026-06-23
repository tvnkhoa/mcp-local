/**
 * Shared test fixtures for the on-demand C# parse suites.
 *
 * `bufferOverflowPad()` returns >32 KB of many short comment lines. It pushes a C# fixture past
 * node-tree-sitter's 32768-byte default buffer (exercising the bufferSize fix — MCP-ISSUE-030;
 * without it the parse throws "Invalid argument") WITHOUT tripping the indexer's minified-file
 * filter, which skips any file whose average line length exceeds 500 over the first 10 KB (a single
 * 40 KB-line comment would be flagged likely_minified and never indexed). ~700 short comment lines
 * (avg ~70 chars) clear both thresholds. Append the result inside a C# source template literal.
 */
export function bufferOverflowPad() {
  return "\n" + Array.from({ length: 700 }, (_, i) => `// pad ${i} ${"x".repeat(60)}`).join("\n") + "\n";
}
