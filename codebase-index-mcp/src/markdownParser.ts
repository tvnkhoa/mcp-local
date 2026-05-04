import { createHash } from "node:crypto";

import type { DocMentionRecord, DocRecord } from "./types.js";

/**
 * Parse markdown file and extract:
 * - docs: headings (H1-H3) and code blocks as doc nodes
 * - mentions: backticks, heading keywords, file paths that reference code
 */
export function parseMarkdownFile(input: {
  repoId: string;
  filePath: string;
  source: string;
}): { docs: DocRecord[]; mentions: DocMentionRecord[] } {
  const docs: DocRecord[] = [];
  const mentions: DocMentionRecord[] = [];

  const lines = input.source.split("\n");
  let currentHeadingPath = input.filePath; // Root level = file itself
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockContent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track heading hierarchy
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      currentHeadingPath = `${input.filePath}#${text}`;

      // Store heading as doc node
      const docId = hashOf(currentHeadingPath);
      docs.push({
        repoId: input.repoId,
        docId,
        filePath: input.filePath,
        headingPath: currentHeadingPath,
        contentType: "heading",
        text: text.slice(0, 500),
        level
      });

      // Extract mentions from heading text
      extractMentionsFromText(text, docId, input.repoId, mentions);
    }

    // Track code blocks
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim().toLowerCase();
        codeBlockContent = "";
      } else {
        inCodeBlock = false;

        // Store code block as doc node
        const docId = hashOf(`${currentHeadingPath}:code:${codeBlockContent.slice(0, 50)}`);
        docs.push({
          repoId: input.repoId,
          docId,
          filePath: input.filePath,
          headingPath: currentHeadingPath,
          contentType: "code_block",
          text: codeBlockContent.slice(0, 500)
          // level not set for code blocks (optional property)
        });

        // Extract mentions from code content
        extractMentionsFromCode(codeBlockContent, docId, input.repoId, mentions);
        codeBlockContent = "";
      }
    } else if (inCodeBlock) {
      codeBlockContent += line + "\n";
    }

    // Extract mentions from paragraphs (backticks + file paths)
    if (!inCodeBlock && !headingMatch) {
      extractMentionsFromText(line, hashOf(currentHeadingPath), input.repoId, mentions);
    }
  }

  // Always add file-level doc node
  const fileDocId = hashOf(input.filePath);
  docs.unshift({
    repoId: input.repoId,
    docId: fileDocId,
    filePath: input.filePath,
    headingPath: input.filePath,
    contentType: "heading",
    text: input.filePath,
    level: 1
  });

  return { docs, mentions };
}

/**
 * Extract mentions from plain text:
 * - Backticks: `functionName`, `ClassName`, etc.
 * - File paths: src/graphStore.ts, codebase-index-mcp/src/index.ts
 */
function extractMentionsFromText(text: string, docId: string, repoId: string, mentions: DocMentionRecord[]): void {
  // Backticks: `symbol`
  const backtickRegex = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
  let match;
  while ((match = backtickRegex.exec(text)) !== null) {
    const symbolName = match[1];
    mentions.push({
      repoId,
      docId,
      symbolId: null, // Will be resolved later
      mentionType: "backtick",
      confidence: 1.0,
      mentionText: symbolName
    });
  }

  // File paths: src/file.ts, path/to/module.tsx
  const filePathRegex = /(?:^|\s|"|\()((?:(?:codebase-index-mcp|postgres-mcp)\/)?src\/[a-zA-Z0-9_\/-]+\.(?:ts|js|tsx|jsx|py|go|java|rb|rs|php|cs))/g;
  while ((match = filePathRegex.exec(text)) !== null) {
    const filePath = match[1];
    mentions.push({
      repoId,
      docId,
      symbolId: null, // Will resolve to module symbol
      mentionType: "filepath",
      confidence: 0.5,
      mentionText: filePath
    });
  }
}

/**
 * Extract mentions from code blocks:
 * - Focus on backticks and identifiers that look like function/class calls
 */
function extractMentionsFromCode(code: string, docId: string, repoId: string, mentions: DocMentionRecord[]): void {
  // Backticks in code context
  const backtickRegex = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
  let match;
  while ((match = backtickRegex.exec(code)) !== null) {
    const symbolName = match[1];
    mentions.push({
      repoId,
      docId,
      symbolId: null,
      mentionType: "backtick",
      confidence: 1.0,
      mentionText: symbolName
    });
  }

  // Function-like calls: functionName(), ClassName.method(), etc.
  const callRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  while ((match = callRegex.exec(code)) !== null) {
    const funcName = match[1];
    // Skip common keywords
    if (!["if", "for", "while", "switch", "catch", "function", "class", "return"].includes(funcName)) {
      mentions.push({
        repoId,
        docId,
        symbolId: null,
        mentionType: "backtick", // Treat as backtick-level confidence since it's code
        confidence: 0.8,
        mentionText: funcName
      });
    }
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}
