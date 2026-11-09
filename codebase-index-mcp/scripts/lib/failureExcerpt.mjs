/**
 * What `run-tests.mjs` prints for a failed script.
 *
 * The tail alone is not enough: `test:unit` runs ~490 node:test cases, and its last lines are the
 * TAP summary (`# pass 490`, `# fail 1`), not the failure. A CI run once failed 490/491 with the
 * failing test's name nowhere in the log. So every `not ok` line comes first, each with its YAML
 * diagnostic block (the assertion, expected/actual, location), then the tail as before.
 *
 * The .mjs harnesses print no TAP: they write `  FAIL  <label>` / `  ✗ <label>` to stderr and `  info  …` (the
 * measured values) to stdout, and `_serverStderr.mjs` then dumps up to 64 KB of the server's stderr on exit 1.
 * CI run 42577407542 failed test:index-lock-contention with both scrolled out of the tail. So those lines come
 * next, before the tail.
 */

const NOT_OK = /^(\s*)not ok \d+ - /;
const HARNESS = /^\s{1,4}(?:FAIL\b|✗|info\s)/;

/**
 * @param {string} output a failed script's stdout + stderr
 * @param {{ tail?: number, maxFailures?: number, maxBlockLines?: number, maxHarnessLines?: number, maxLineChars?: number }} [options]
 * @returns {string[]} the lines to print, unindented
 */
export function failureExcerpt(output, { tail = 25, maxFailures = 10, maxBlockLines = 40, maxHarnessLines = 40, maxLineChars = 2000 } = {}) {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return ["(no output)"];

  const failures = [];
  let total = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = NOT_OK.exec(lines[i]);
    if (match === null) continue;
    total += 1;
    if (failures.length >= maxFailures) continue;
    const block = [lines[i]];
    // The YAML block opens with `---` one level deeper than the `not ok` line and closes with `...`.
    if (lines[i + 1]?.trim() === "---") {
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== "..."; j += 1) block.push(lines[j]);
      if (j < lines.length) block.push(lines[j]);
    }
    failures.push(block.length > maxBlockLines ? [...block.slice(0, maxBlockLines), "  … (block truncated)"] : block);
  }

  // Harness lines already inside the tail are not repeated.
  const tailStart = Math.max(0, lines.length - tail);
  const harness = [];
  let harnessTotal = 0;
  for (let i = 0; i < tailStart; i += 1) {
    if (!HARNESS.test(lines[i])) continue;
    harnessTotal += 1;
    if (harness.length < maxHarnessLines) {
      harness.push(lines[i].length > maxLineChars ? `${lines[i].slice(0, maxLineChars)} … (line truncated)` : lines[i]);
    }
  }

  const out = [];
  if (total > 0) {
    out.push(`${String(total)} failing test(s)${total > maxFailures ? `, first ${String(maxFailures)} shown` : ""}:`);
    for (const block of failures) out.push(...block);
  }
  if (harnessTotal > 0) {
    if (out.length > 0) out.push("");
    out.push(`harness FAIL/info line(s)${harnessTotal > maxHarnessLines ? `, first ${String(maxHarnessLines)} of ${String(harnessTotal)}` : ""}:`);
    out.push(...harness);
  }
  if (out.length > 0) out.push("", `last ${String(Math.min(tail, lines.length))} line(s):`);
  out.push(...lines.slice(-tail));
  return out;
}
