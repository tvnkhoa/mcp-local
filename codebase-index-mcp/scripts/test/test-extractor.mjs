import { extractGraphData } from '../dist/treeSitterExtractor.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { readFileSync } from 'fs';

const source = readFileSync('./src/graphStore.ts', 'utf8');
console.log('File length:', source.length);

// Test with explicit large buffer
const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

try {
  const tree = parser.parse(source, undefined, { bufferSize: 1024 * 1024 });
  console.log('parse with 1MB buffer: OK, root type:', tree.rootNode.type);
} catch(e) {
  console.log('parse with 1MB buffer: FAIL -', e.message);
}

try {
  const tree = parser.parse(source);
  console.log('parse default buffer: OK');
} catch(e) {
  console.log('parse default buffer: FAIL -', e.message);
}

// extractGraphData fail
try {
  const r = extractGraphData({ repoId: 'x', filePath: 'f.ts', language: 'typescript', source });
  console.log('extractGraphData: OK -', r.symbols.length, 'symbols');
} catch(e) {
  console.log('extractGraphData: FAIL -', e.message);
}
