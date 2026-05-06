import { glob } from "glob";
import path from "node:path";

const repoPath = "D:/1.SourceCode/crm/wec.be";

const files = await glob("**/*.cs", {
  cwd: repoPath,
  absolute: true,
  windowsPathsNoEscape: true,
  ignore: ["**/obj/**", "**/bin/**", "**/node_modules/**"]
});

const relativePaths = files.map(f => path.relative(repoPath, f));
const lower = relativePaths.map(f => f.toLowerCase());
const set = new Set(lower);
const dups = lower.filter((f, i) => lower.indexOf(f) < i);

console.log(`total: ${files.length}, unique (case-insensitive): ${set.size}, duplicates: ${dups.length}`);
if (dups.length > 0) {
  dups.slice(0, 5).forEach(d => {
    const indices = lower.map((x, i) => x === d ? i : -1).filter(i => i >= 0);
    console.log("dup:", d);
    indices.forEach(i => console.log("  -> ", relativePaths[i]));
  });
}
