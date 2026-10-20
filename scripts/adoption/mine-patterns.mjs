// What were the greps LOOKING FOR? Extracts the pattern of each grep/rg (and Grep tool) call and
// classifies its shape. Usage: node mine-patterns.mjs <project transcripts dir>
// Also importable: `collectPatterns(dir)` and `cls(pattern)` feed scripts/adoption/replay.mjs, so the
// replay sample is classified exactly as this report is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const transcriptFiles = (dir) => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
  for (const d of fs.readdirSync(dir)) {
    const sub = path.join(dir, d, 'subagents');
    if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));
  }
  return files;
};
// shell-ish tokenizer good enough for grep lines
const tokens = (s) => {
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // Inside double quotes the shell only escapes $ ` " \\ and newline; `"scope\\b"` keeps its backslash.
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) cur += s[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '|' ) break;
    if (/\s/.test(c)) { if (cur) out.push(cur), (cur = ''); continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
};
const patternOf = (seg) => {
  const t = tokens(seg); t.shift();
  const pats = []; let i = 0;
  while (i < t.length) {
    const a = t[i];
    if (a === '-e' || a === '--regexp') { pats.push(t[i + 1]); i += 2; continue; }
    if (/^-[ABCm]$/.test(a) || a === '--include' || a === '--exclude' || a === '-f') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    if (pats.length === 0) pats.push(a);
    i++;
  }
  return pats.filter(Boolean);
};
export const cls = (p) => {
  const k = [];
  if (/(^|[^\w])(#\s?\d{2,4}\b|15 #|docs\/15|adr\/?\d{3,4}|SPEC-\d|0\d{3}\b|09 #)/i.test(p)) k.push('citation (docs/15 #N, adr, SPEC, 09 #)');
  if (/^\^?(#|\\\*\\\*|\*\*|- \*\*|\|)|§|BACKLOG|Status/.test(p)) k.push('markdown structure (heading, **Status**, §, table row)');
  if (/^\^?\s*(export |const |function |async |class |type |interface )|^\^?(export|const|function)\b/.test(p)) k.push('definition site (^export / ^const / ^function)');
  if (/[{}()\[\]].*\|.*[{}()\[\]]|\.\*|\\s/.test(p) && p.split('|').length >= 3) k.push('multi-alternative regex (3+ terms)');
  if (/--[a-z][\w-]+|var\(|\.css|\bclass=|:root|font-|color|padding|margin/.test(p)) k.push('CSS token / class / style');
  if (/<[A-Z][A-Za-z]+|<template|<script|v-if|v-for|@click|:[a-z]+=|defineProps|defineEmits|emit\(/.test(p)) k.push('Vue template / component');
  if (/\b[a-z]+(_[a-z0-9]+)+\b/.test(p)) k.push('snake_case name (docs/10 / contracts field)');
  if (/\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(p) && !/[A-Z]{2}/.test(p)) k.push('camelCase identifier');
  if (/\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/.test(p)) k.push('PascalCase type / component');
  if (/\/(api|dealer|review|documents|knowledge|v1)\b|GET |POST |route|path:/.test(p)) k.push('route / endpoint');
  if (/import|from ['"]|export /.test(p)) k.push('import / export');
  if (/\b(it|describe|test)\(/.test(p)) k.push('test name');
  if (/"status"|"phase"|"id":|claim|unit|LANDED|board/.test(p)) k.push('board / json state');
  if (/TODO|FIXME|Backlog|⏸/.test(p)) k.push('TODO / backlog marker');
  if (/[ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠàáâãèéêìíòóôõùúăđĩũơưạ-ỹ]/.test(p)) k.push('Vietnamese / owner words');
  if (/\s[a-z]+\s[a-z]+/.test(p) && !k.length) k.push('English prose phrase (doc sentence)');
  if (!k.length) k.push(/^[\w.-]+$/.test(p) ? 'bare word / other identifier' : 'other regex');
  return k;
};
/** Every grep/rg/Grep pattern in the transcripts under `dir`, in transcript order. */
export function collectPatterns(dir) {
  const out = [];
  for (const f of transcriptFiles(dir)) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const content = o.message?.content; if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Grep' && c.input?.pattern) { out.push(c.input.pattern); continue; }
      if (c.name !== 'Bash' && c.name !== 'PowerShell') continue;
      for (const seg of String(c.input.command || '').split(/&&|\|\||;|\n|\$\(/)) {
        const s = seg.trim();
        if (!/^(grep|rg)\b/.test(s)) continue;
        for (const p of patternOf(s)) out.push(p);
      }
    }
  }
}
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = {}; const samples = {};
  const patterns = collectPatterns(process.argv[2]);
  for (const p of patterns) for (const k of cls(p)) { count[k] = (count[k] || 0) + 1; (samples[k] ??= []).length < 6 && samples[k].push(p.slice(0, 70)); }
  console.log('patterns', patterns.length);
  for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k, '\n        e.g.', samples[k].slice(0, 4).map(s => JSON.stringify(s)).join('  '));
}
