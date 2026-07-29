#!/usr/bin/env node
/**
 * Test script to diagnose markdown extraction issue
 */

import fs from "node:fs";
import path from "node:path";
import { shouldIndexFile } from "../../dist/indexing/fileFilter.js";
import { parseMarkdownFile } from "../../dist/extractors/markdownParser.js";
import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

const testDir = process.cwd();

console.log("=== Testing Markdown Extraction ===\n");

// Test 1: Check which .md files exist
console.log("1. Markdown files in repository:");
const mdFiles = fs.readdirSync(testDir, { recursive: true })
  .filter(f => typeof f === "string" && f.endsWith(".md"))
  .slice(0, 10);
console.log(mdFiles.map(f => "  " + f).join("\n"));

// Test 2: Test fileFilter on a known markdown file
console.log("\n2. File filter decisions on markdown:");
const testMdFiles = [
  "README.md",
  "CHANGELOG.md",
  ".github/copilot-instructions.md",
];

for (const file of testMdFiles) {
  const fullPath = path.join(testDir, file);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath);
    const decision = shouldIndexFile(file, new Uint8Array(content));
    console.log(
      `  ${file}: include=${decision.include} language=${decision.language} (${decision.reason})`
    );
  } else {
    console.log(`  ${file}: FILE NOT FOUND`);
  }
}

// Test 3: Test markdown parser on actual content
console.log("\n3. Markdown parser on README.md:");
const readmePath = path.join(testDir, "README.md");
if (fs.existsSync(readmePath)) {
  const content = fs.readFileSync(readmePath, "utf8");
  try {
    const result = parseMarkdownFile({
      repoId: "test",
      filePath: "README.md",
      source: content
    });
    console.log(`  Extracted ${result.docs.length} docs, ${result.mentions.length} mentions`);
    if (result.docs.length > 0) {
      console.log(`  First doc: ${result.docs[0].heading_path} (${result.docs[0].content_type})`);
    }
    if (result.mentions.length > 0) {
      console.log(`  First mention: ${result.mentions[0].mention_text} (${result.mentions[0].mention_type}, confidence=${result.mentions[0].confidence})`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
} else {
  console.log(`  README.md not found`);
}

// Test 4: Test extractGraphData with markdown
console.log("\n4. Tree-sitter extractor on markdown:");
if (fs.existsSync(readmePath)) {
  const content = fs.readFileSync(readmePath, "utf8");
  try {
    const result = extractGraphData({
      repoId: "test",
      filePath: "README.md",
      language: "markdown",
      source: content
    });
    console.log(`  Symbols: ${result.symbols.length}`);
    console.log(`  Edges: ${result.edges.length}`);
    console.log(`  Docs: ${result.docs?.length ?? 0}`);
    console.log(`  Mentions: ${result.mentions?.length ?? 0}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

console.log("\n=== END ===");
