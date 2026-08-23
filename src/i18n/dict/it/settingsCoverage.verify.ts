import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { EN } from '../en';
import { IT } from './index';

const ROOT = process.cwd();
const SETTINGS_ROOT = path.join(ROOT, 'src', 'components', 'settings');
const CJK = /[\u3400-\u9fff]/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const settingsKeys = new Set<string>();
for (const filePath of walk(SETTINGS_ROOT).filter((file) => /\.tsx?$/.test(file) && !/\.verify\.tsx?$/.test(file))) {
  const sf = sourceFile(filePath);
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) && CJK.test(node.text) && EN[node.text]) {
      settingsKeys.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const missing = [...settingsKeys].filter((key) => !IT[key]).sort((a, b) => a.localeCompare(b));
assert.deepEqual(missing, [], `Italian settings dictionary is missing ${missing.length} keys:\n${missing.join('\n')}`);
console.log(`settingsCoverage.verify: ok (${settingsKeys.size} settings keys covered)`);
