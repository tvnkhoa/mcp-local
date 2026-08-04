import { createHash } from "node:crypto";

import type { DocMentionRecord, DocRecord } from "../../types/index.js";

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

    // Fences and their contents are settled before anything else looks at the line.
    //
    // MCP-ISSUE-049: the heading match used to run unconditionally, so a `# comment` inside a shell
    // or bash fence became a real heading — it published a doc node, reset `currentHeadingPath` for
    // every following line, and fed its backticked identifiers into the prose signal. In a repo
    // whose docs are largely command samples that is a steady source of the same false positive
    // this issue is about.
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
      continue;
    }
    if (inCodeBlock) {
      codeBlockContent += line + "\n";
      continue;
    }

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
      continue;
    }

    // Prose line: backticks + file paths.
    extractMentionsFromText(line, hashOf(currentHeadingPath), input.repoId, mentions);
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
  // Backticks *inside* a fenced block — a nested backtick in a comment or a doc-comment sample.
  //
  // MCP-ISSUE-049: this branch is code-block provenance exactly like the call branch below, and it
  // kept emitting `backtick` after that one was corrected — so a fenced-code identifier could still
  // enter the prose signal and be reported as documentation of a same-named symbol. Everything
  // harvested from inside a fence is `code_call`; the mention type records where the text came
  // from, not what shape it had once it got there.
  const backtickRegex = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
  let match;
  while ((match = backtickRegex.exec(code)) !== null) {
    const symbolName = match[1];
    mentions.push({
      repoId,
      docId,
      symbolId: null,
      mentionType: "code_call",
      confidence: 0.5,
      mentionText: symbolName
    });
  }

  // Function-like calls: functionName(), ClassName.method(), etc.
  //
  // MCP-ISSUE-049: recorded as `code_call`, NOT `backtick`. Every identifier followed by `(` in a
  // pasted code sample lands here — `Parse(`, `Handle(`, `Deserialize(` — and calling that a
  // "backtick mention" made an archived doc containing a C# snippet register as documentation of
  // whatever same-named symbol happened to exist. It is a "this symbol appears in an example" signal,
  // which is worth keeping and is not worth treating as prose.
  const callRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  while ((match = callRegex.exec(code)) !== null) {
    const funcName = match[1];
    // Skip common keywords
    if (!["if", "for", "while", "switch", "catch", "function", "class", "return"].includes(funcName)) {
      mentions.push({
        repoId,
        docId,
        symbolId: null,
        mentionType: "code_call",
        confidence: 0.5,
        mentionText: funcName
      });
    }
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}
