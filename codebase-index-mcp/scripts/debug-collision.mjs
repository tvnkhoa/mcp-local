import { readFileSync } from "node:fs";
import { extractGraphData } from "../dist/treeSitterExtractor.js";
import { glob } from "glob";
import path from "node:path";

const repoPath = "D:/1.SourceCode/crm/wec.be";
const repoId = "wec.be";

const files = await glob("**/*.cs", {
  cwd: repoPath,
  absolute: true,
  windowsPathsNoEscape: true,
  ignore: ["**/obj/**", "**/bin/**", "**/node_modules/**"]
});

console.log(`Scanning ${files.length} C# files...`);

const symbolMap = new Map(); // symbolId → { file, symbol }
let collision = null;
let fileCount = 0;

for (const f of files) {
  const relativePath = path.relative(repoPath, f);
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  let result;
  try {
    result = extractGraphData({ repoId, filePath: relativePath, language: "csharp", source: src });
  } catch (e) {
    console.warn(`[parse-fail] ${relativePath}: ${e.message}`);
    continue;
  }

  for (const s of result.symbols) {
    if (symbolMap.has(s.symbolId)) {
      const existing = symbolMap.get(s.symbolId);
      if (existing.symbol.symbolId === s.symbolId) {
        collision = { existing, duplicate: { file: relativePath, symbol: s } };
        break;
      }
    }
    symbolMap.set(s.symbolId, { file: relativePath, symbol: s });
  }

  if (collision) break;
  fileCount++;
  if (fileCount % 500 === 0) process.stderr.write(`  ... ${fileCount} files done\n`);
}

if (collision) {
  console.log("COLLISION FOUND:");
  console.log(JSON.stringify(collision, null, 2));
} else {
  console.log(`OK — no collision. Scanned ${fileCount} files, ${symbolMap.size} unique symbolIds.`);
}
