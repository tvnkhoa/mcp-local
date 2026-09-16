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
    //
    // MCP-ISSUE-061(e): the test was `line.startsWith`, so a fence INDENTED inside a list item never
    // toggled `inCodeBlock` — 28 of them in this workspace. Their bodies were scanned as prose and
    // any `# comment` inside them still became a heading, i.e. 049 was fixed only for the
    // column-zero case. CommonMark allows up to three leading spaces before a fence; more than that
    // is an indented code block, which this parser does not track, so trimming the whole run is the
    // closer approximation of the two.
    const fenceLine = line.trimStart();
    if (fenceLine.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = fenceLine.slice(3).trim().toLowerCase();
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
      extractMentionsFromText(text, docId, input.repoId, mentions, input.filePath);
      continue;
    }

    // Prose line: backticks + file paths.
    extractMentionsFromText(line, hashOf(currentHeadingPath), input.repoId, mentions, input.filePath);
  }

  // Always add file-level doc node
  const fileDocId = hashOf(input.filePath);
  const lifecycle = detectLifecycle(input.filePath, input.source);
  docs.unshift({
    repoId: input.repoId,
    docId: fileDocId,
    filePath: input.filePath,
    headingPath: input.filePath,
    contentType: "heading",
    text: input.filePath,
    level: 1,
    ...(lifecycle.docStatus && { docStatus: lifecycle.docStatus }),
    ...(lifecycle.supersededBy && { supersededBy: lifecycle.supersededBy })
  });

  return { docs, mentions };
}

/**
 * Extract mentions from plain text:
 * - Backticks: `functionName`, `ClassName`, etc.
 * - File paths: src/graphStore.ts, codebase-index-mcp/src/index.ts
 */
function extractMentionsFromText(text: string, docId: string, repoId: string, mentions: DocMentionRecord[], sourceFilePath: string): void {
  extractDocLinks(text, docId, repoId, mentions, sourceFilePath);

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

/**
 * Document lifecycle. MCP-ISSUE-061 Stage 3.
 *
 * `CLAUDE.md` has to carry the sentence *"Nothing there is maintained; do not read a current state
 * out of it"* about `docs/archive/`. That sentence exists because agents keep reading state out of
 * the archive, and prose cannot stop them. This makes it queryable instead.
 *
 * **Front matter was the obvious mechanism and it is the wrong one here.** Measured over this
 * workspace: 39 of 107 markdown files open with a `---` block, and every one is a Claude Code
 * artifact (SKILL.md, a rule, a command) whose only keys are `name`, `description` and
 * `argument-hint`. **Zero of the 47 files under `docs/` have front matter at all**, and `owner` /
 * `tags` / `status` appear nowhere as YAML keys. A front-matter reader would have returned nothing
 * for the entire documentation tree.
 *
 * What this workspace actually uses is a bold-key body line with an **em-dash, not a colon** — all
 * four ADRs follow `docs/decisions/README.md`'s convention, and 32 files carry the same shape for
 * `**Risk**` / `**Complexity**` / `**Rollback**`. Both separators are accepted here because a
 * convention documented in prose is a convention people spell two ways.
 *
 * The path rule is the general half: a segment named `archive`, `_archive`, `superseded` or
 * `deprecated` marks a document inactive regardless of its body. That is structural and holds in any
 * repository, where mining a specific index file's link table would not.
 *
 * Scanned over the first 60 lines only — a status line belongs near the top, and reading further
 * invites a false positive from a document *quoting* a status.
 */
function detectLifecycle(filePath: string, source: string): { docStatus?: string; supersededBy?: string } {
  const segments = filePath.replace(/\\/g, "/").toLowerCase().split("/");
  const archived = segments.some((s) => s === "archive" || s === "_archive" || s === "superseded" || s === "deprecated");

  const head = source.split("\n", 60).join("\n");
  const statusLine = head.match(/^\s*\*\*Status\*\*\s*(?:—|–|-|:)\s*(.+)$/im);
  const raw = statusLine ? statusLine[1].trim() : "";

  let supersededBy: string | undefined;
  const supersedes = raw.match(/superseded\s+by\s+(.+?)\s*$/i);
  if (supersedes) supersededBy = supersedes[1].replace(/[.*_`]+$/g, "").trim() || undefined;

  let docStatus: string | undefined;
  if (supersededBy) docStatus = "superseded";
  else if (/^superseded/i.test(raw)) docStatus = "superseded";
  else if (/^accepted/i.test(raw)) docStatus = "accepted";
  else if (/^proposed/i.test(raw)) docStatus = "proposed";
  else if (/^draft/i.test(raw)) docStatus = "draft";
  else if (/^(deprecated|obsolete)/i.test(raw)) docStatus = "archived";

  // The path wins only when the body said nothing — an archived ADR that still records
  // "Accepted" is accurately both, and the path is the fact a reader needs.
  if (archived) docStatus = docStatus === "superseded" ? "superseded" : "archived";

  return { docStatus, supersededBy };
}

/**
 * Doc → doc edges. MCP-ISSUE-061 Stage 3.
 *
 * `search_regex` can find a string in a document; it cannot tell you which documents point at this
 * one, which are orphaned, or which links are broken. Those are set operations over an index, and
 * they are the part of a docs-first workflow a text search will never cover.
 *
 * The corpus decided the scope, so this is deliberately narrow. Measured over `mcp-local`'s 107
 * markdown files: **319 relative `.md` links, 0 wiki-links, 0 external URLs, 0 reference-style
 * definitions, 0 autolinks, and 0 links carrying a `#fragment`.** So one CommonMark inline matcher
 * and three resolution rules cover everything that exists — bare relative (133 links), `../` (140)
 * and `./` (46) — and support for the forms this workspace does not use would be dead code.
 *
 * Two exclusions that are not arbitrary:
 * - **Pure `#anchor` links (23 of them) are intra-document** and would make every file its own
 *   neighbour.
 * - **Anything inside a fence never reaches here.** The caller routes fenced lines to
 *   `extractMentionsFromCode`, which is why link-shaped text in the 311 code samples does not become
 *   an edge. Markdown tables DO reach here, and that is correct — `docs/archive/README.md` encodes
 *   its supersession map as a table of links.
 *
 * `mentionText` is the resolved repo-relative path with forward slashes, so it can be matched
 * against `docs.file_path` (which stores the platform separator) after the same normalization.
 */
function extractDocLinks(
  text: string,
  docId: string,
  repoId: string,
  mentions: DocMentionRecord[],
  sourceFilePath: string
): void {
  // CommonMark inline link. The target stops at whitespace or `)` so a title (`[x](y "t")`) is
  // dropped rather than folded into the path.
  const linkRegex = /\[[^\]]*\]\(\s*([^)\s]+)/g;
  const sourceDir = sourceFilePath.replace(/\\/g, "/").split("/").slice(0, -1);

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(text)) !== null) {
    const rawTarget = match[1];

    if (rawTarget.startsWith("#")) continue; // intra-document anchor
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue; // http:, mailto:, etc.
    if (!/\.mdx?($|#|\?)/i.test(rawTarget)) continue; // only doc→doc edges

    const target = rawTarget.split("#")[0].split("?")[0];
    const segments = target.startsWith("/")
      ? target.slice(1).split("/")
      : [...sourceDir, ...target.split("/")];

    // Resolve `.` and `..` without touching the filesystem — the link may be broken, and reporting
    // that is the point.
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") resolved.pop();
      else resolved.push(seg);
    }
    const resolvedPath = resolved.join("/");
    if (resolvedPath === "") continue;

    mentions.push({
      repoId,
      docId,
      symbolId: null, // a doclink targets a document, not a symbol — it never resolves to one
      mentionType: "doclink",
      confidence: 1.0,
      mentionText: resolvedPath
    });
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}
