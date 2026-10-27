/**
 * What `run-tests.mjs` prints for a failed script.
 *
 * The tail alone is not enough: `test:unit` runs ~490 node:test cases, and its last lines are the
 * TAP summary (`# pass 490`, `# fail 1`), not the failure. A CI run once failed 490/491 with the
 * failing test's name nowhere in the log. So every `not ok` line comes first, each with its YAML
 * diagnostic block (the assertion, expected/actual, location), then the tail as before.
 */

const NOT_OK = /^(\s*)not ok \d+ - /;

/**
 * @param {string} output a failed script's stdout + stderr
 * @param {{ tail?: number, maxFailures?: number, maxBlockLines?: number }} [options]
 * @returns {string[]} the lines to print, unindented
 */
export function failureExcerpt(output, { tail = 25, maxFailures = 10, maxBlockLines = 40 } = {}) {
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

  const out = [];
  if (total > 0) {
    out.push(`${String(total)} failing test(s)${total > maxFailures ? `, first ${String(maxFailures)} shown` : ""}:`);
    for (const block of failures) out.push(...block);
    out.push("", `last ${String(Math.min(tail, lines.length))} line(s):`);
  }
  out.push(...lines.slice(-tail));
  return out;
}
