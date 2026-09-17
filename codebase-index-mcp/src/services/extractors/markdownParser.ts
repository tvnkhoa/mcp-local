import { createHash } from "node:crypto";

import type { DocMentionRecord, DocRecord } from "../../types/index.js";

/**
 * Chunk budget in characters. ~512 tokens at the chars/4 approximation this workspace uses.
 *
 * Measured over the 1 374 heading-delimited sections in `mcp-local`: median 640 characters, p90
 * 2 149, and 90% under 2 KB. So one section is normally one chunk and the splitter is the exception,
 * not the rule — roughly 33 sections workspace-wide exceed it. A smaller budget would fragment the
 * median section for nothing; a larger one mostly pads.
 */
const PROSE_CHUNK_CHARS = 2048;

/** A code block's stored text. MCP-ISSUE-061 Stage 4: 500 truncated 12.9% of blocks, 1000 truncates 1.9% (p90 is 573). */
const CODE_BLOCK_TEXT_CHARS = 1000;

const HEADING_TEXT_CHARS = 500;

/**
 * Parse a markdown file into doc nodes and mentions.
 *
 * MCP-ISSUE-061 Stage 4 rewrote the loop. It previously emitted headings and code blocks only, and
 * scraped each prose line for mentions before **discarding the line** — so `docs` held no prose at
 * all, and `query_docs{mode:"search"}` answered from heading text averaging 35 characters. A phrase
 * present verbatim in a document returned `count: 0`.
 *
 * Four things the rewrite had to get right, each one a defect in the old loop:
 *
 * 1. **Four flush points, including EOF.** A prose run ends at a heading, at a fence opening, and at
 *    EOF; a fence closing starts a new one. The old loop had no EOF handling of any kind, so a file
 *    ending inside an open fence silently discarded that fence's content and emitted no node.
 * 2. **Never split a table.** Tables are 21% of all content lines here and the median one is 7 rows
 *    by 3 columns, which fits a chunk beside its heading. A table cut in half loses the header row
 *    and with it the meaning of every cell.
 * 3. **`\r` is stripped.** `core.autocrlf=true` means a fresh Windows clone is CRLF throughout. The
 *    old loop survived only because `.trim()` incidentally cleaned headings; prose lines were never
 *    trimmed, so storing them raw would have put a trailing carriage return on every line and
 *    polluted the FTS tokens.
 * 4. **Mentions are emitted once per chunk, not once per line.** Scraping per line and again per
 *    buffer would double every identifier.
 *
 * docIds now hash the start line rather than a content prefix, which makes them collision-free by
 * construction: two nodes cannot begin on the same line. The old code-block id hashed the first 50
 * characters after the heading and silently overwrote its twin (MCP-ISSUE-061(f)).
 */
export function parseMarkdownFile(input: {
  repoId: string;
  filePath: string;
  source: string;
}): { docs: DocRecord[]; mentions: DocMentionRecord[] } {
  const docs: DocRecord[] = [];
  const mentions: DocMentionRecord[] = [];

  const lines = input.source.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const headingStack: { level: number; text: string }[] = [];
  let currentHeadingPath = input.filePath; // Root level = file itself
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockContent = "";
  let codeBlockStart = 0;

  // Prose accumulator. `start` is 1-based, matching how every other line number in this server reads.
  let proseLines: string[] = [];
  let proseStart = 0;

  const flushProse = (endLine: number): void => {
    if (proseLines.length === 0) return;
    for (const chunk of chunkProse(proseLines, proseStart)) {
      const docId = hashOf(`${input.filePath}:prose:${chunk.startLine}`);
      docs.push({
        repoId: input.repoId,
        docId,
        filePath: input.filePath,
        headingPath: currentHeadingPath,
        contentType: "prose",
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      });
      // Once per chunk. Emitting per line as well would double every identifier.
      extractMentionsFromText(chunk.text, docId, input.repoId, mentions, input.filePath);
    }
    proseLines = [];
    proseStart = 0;
    void endLine;
  };

  /**
   * YAML front matter is metadata, not body.
   *
   * 39 of this workspace's 107 markdown files open with a `---` block — every Claude Code skill,
   * rule and command — and until this guard the rewritten loop stored their `name:` and
   * `description:` lines as prose. The recall harness caught it immediately: asked for a phrase that
   * occurs in exactly one file, it picked front matter from twelve files in a row, because those
   * lines are by construction unique and sit at line 1. `detectLifecycle` already reads the block for
   * `**Status**`; the body extractor should not see it at all.
   */
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) bodyStart = close + 1;
  }

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

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
        flushProse(lineNo - 1); // a fence ends the prose run before it
        inCodeBlock = true;
        codeBlockLang = fenceLine.slice(3).trim().toLowerCase();
        codeBlockContent = "";
        codeBlockStart = lineNo;
      } else {
        inCodeBlock = false;
        emitCodeBlock(codeBlockContent, codeBlockStart, lineNo);
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
      flushProse(lineNo - 1); // BEFORE the heading path moves, or the section files under the next one
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      // Ancestry, not just the last heading. MCP-ISSUE-061(f): `filePath#text` alone collided
      // whenever a heading text repeated in one file, and it gave the response layer no breadcrumb.
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      currentHeadingPath = `${input.filePath}#${headingStack.map((h) => h.text).join(">")}`;

      const docId = hashOf(`${input.filePath}:heading:${lineNo}`);
      docs.push({
        repoId: input.repoId,
        docId,
        filePath: input.filePath,
        headingPath: currentHeadingPath,
        contentType: "heading",
        text: text.slice(0, HEADING_TEXT_CHARS),
        level,
        startLine: lineNo,
        endLine: lineNo
      });

      extractMentionsFromText(text, docId, input.repoId, mentions, input.filePath);
      continue;
    }

    if (proseLines.length === 0) {
      if (line.trim() === "") continue; // do not open a run on blank lines
      proseStart = lineNo;
    }
    proseLines.push(line);
  }

  // EOF. Neither of these existed before: a file ending mid-prose lost the tail, and a file ending
  // inside an unterminated fence lost the fence entirely and emitted nothing for it.
  flushProse(lines.length);
  if (inCodeBlock && codeBlockContent !== "") {
    emitCodeBlock(codeBlockContent, codeBlockStart, lines.length);
  }

  function emitCodeBlock(content: string, startLine: number, endLine: number): void {
    const docId = hashOf(`${input.filePath}:code:${startLine}`);
    docs.push({
      repoId: input.repoId,
      docId,
      filePath: input.filePath,
      headingPath: currentHeadingPath,
      contentType: "code_block",
      text: content.slice(0, CODE_BLOCK_TEXT_CHARS),
      startLine,
      endLine
    });
    extractMentionsFromCode(content, docId, input.repoId, mentions);
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
    startLine: 1,
    endLine: lines.length,
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

const isTableRow = (line: string) => /^\s*\|/.test(line);

/**
 * Split an accumulated prose run into chunks, respecting the one structure markdown has that cannot
 * survive being cut: the table.
 *
 * Tables are **21% of every content line** in this workspace — 320 of them across 73 of 107 files —
 * so this is not an edge case. A table split down the middle loses its header row, and without the
 * header a row of cells means nothing at all. So a contiguous run of `|`-leading lines is one
 * indivisible unit, and only a table larger than the whole budget is split — by row groups, with the
 * header and separator repeated into each fragment. Twelve tables here exceed 20 rows; those are the
 * ones that reach that path.
 */
function chunkProse(
  lines: string[],
  startLine: number
): { text: string; startLine: number; endLine: number }[] {
  // Group into units: a table run is one unit, every other line is its own.
  const units: { lines: string[]; start: number; isTable: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i])) {
      const start = i;
      while (i < lines.length && isTableRow(lines[i])) i++;
      units.push({ lines: lines.slice(start, i), start: startLine + start, isTable: true });
      i--;
    } else {
      units.push({ lines: [lines[i]], start: startLine + i, isTable: false });
    }
  }

  const out: { text: string; startLine: number; endLine: number }[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let bufChars = 0;

  const flush = (endLine: number) => {
    const text = buf.join("\n").trim();
    if (text !== "") out.push({ text, startLine: bufStart, endLine });
    buf = [];
    bufChars = 0;
  };

  for (const unit of units) {
    const unitChars = unit.lines.reduce((n, l) => n + l.length + 1, 0);

    if (unit.isTable && unitChars > PROSE_CHUNK_CHARS) {
      flush(unit.start - 1);
      // Header + separator repeated per fragment, or the cells lose their meaning.
      const header = unit.lines.slice(0, 2);
      const body = unit.lines.slice(2);
      const headerChars = header.reduce((n, l) => n + l.length + 1, 0);
      let group: string[] = [];
      let groupStart = unit.start + 2;
      let groupChars = headerChars;
      for (let r = 0; r < body.length; r++) {
        const rowChars = body[r].length + 1;
        if (group.length > 0 && groupChars + rowChars > PROSE_CHUNK_CHARS) {
          out.push({ text: [...header, ...group].join("\n"), startLine: groupStart, endLine: unit.start + 1 + r });
          group = [];
          groupStart = unit.start + 2 + r;
          groupChars = headerChars;
        }
        group.push(body[r]);
        groupChars += rowChars;
      }
      if (group.length > 0) {
        out.push({ text: [...header, ...group].join("\n"), startLine: groupStart, endLine: unit.start + unit.lines.length - 1 });
      }
      bufStart = 0;
      continue;
    }

    if (buf.length > 0 && bufChars + unitChars > PROSE_CHUNK_CHARS) {
      flush(unit.start - 1);
    }
    if (buf.length === 0) bufStart = unit.start;
    buf.push(...unit.lines);
    bufChars += unitChars;
  }

  if (buf.length > 0) {
    const last = units[units.length - 1];
    flush(last.start + last.lines.length - 1);
  }
  return out;
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
