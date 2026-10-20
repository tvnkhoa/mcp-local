import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
for (const d of fs.readdirSync(dir)) {
  const sub = path.join(dir, d, 'subagents');
  if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));
}
const cmds = [];
const greps = { code: 0, docs: 0, both: 0, other: 0 };
const grepCat = {};
const nodeScripts = {};
const tag = (k) => (grepCat[k] = (grepCat[k] || 0) + 1);
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const content = o.message?.content; if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Bash' || c.name === 'PowerShell') {
        const cmd = String(c.input.command || '');
        cmds.push(cmd);
        for (const seg of cmd.split(/&&|\|\||;|\n/)) {
          const s = seg.trim();
          const m = s.match(/^node\s+(?:--\S+\s+)*(\S+\.m?js)/); if (m) nodeScripts[m[1]] = (nodeScripts[m[1]] || 0) + 1;
          if (/^(grep|rg)\b/.test(s)) {
            if (/docs\/15|log-index/.test(s)) tag('docs/15 decision log rows');
            else if (/docs\/10|canonical/.test(s)) tag('docs/10 canonical names');
            else if (/docs\/adr/.test(s)) tag('ADRs');
            else if (/\.md\b|docs\/|specs\/|BACKLOG|SCREENS|CLAUDE/.test(s)) tag('other docs/specs');
            else if (/evals\//.test(s)) tag('evals');
            else if (/checks\//.test(s)) tag('checks/ + board');
            else if (/packages\/portal|packages\/console|\.vue/.test(s)) tag('portal/console UI code');
            else if (/packages\/contracts/.test(s)) tag('contracts');
            else if (/packages\/core/.test(s)) tag('core');
            else if (/packages\//.test(s)) tag('other packages');
            else if (/\.jsonl|\.json|\.log|scratchpad|Temp/.test(s)) tag('json/logs/scratch output');
            else tag('unclassified (piped)');
          }
        }
      }
    }
  }
}
console.log('files', files.length, 'shell cmds', cmds.length);
console.log('grep targets', Object.entries(grepCat).sort((a, b) => b[1] - a[1]));
console.log('node scripts', Object.entries(nodeScripts).sort((a, b) => b[1] - a[1]).slice(0, 30));
