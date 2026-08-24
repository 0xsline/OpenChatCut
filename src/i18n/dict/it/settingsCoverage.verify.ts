import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { EN } from '../en';
import { IT } from './index';
import { SETTINGS_CATEGORIES } from '../../../components/settings/settingsSchema';
import type { SettingsField, SettingsVendorPage } from '../../../components/settings/settingsFields';

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

const dataKeys = new Set<string>();
function add(value: string | undefined): void {
  if (value && CJK.test(value)) dataKeys.add(value);
}
function addField(field: SettingsField): void {
  add(field.label);
  add(field.defaultLabel);
  add(field.placeholder);
  add(field.note);
  field.options?.forEach((option) => add(option.label));
}
function addPage(page: SettingsVendorPage): void {
  add(page.title);
  add(page.note);
  add(page.noteAction?.label);
  page.fields.forEach(addField);
}
for (const category of SETTINGS_CATEGORIES) {
  add(category.title);
  for (const group of category.groups) {
    add(group.title);
    add(group.hint);
    if (group.route) addField(group.route);
    group.vendors.forEach(addPage);
  }
}

const missingEnglishDataKeys = [...dataKeys].filter((key) => !EN[key]).sort((a, b) => a.localeCompare(b));
assert.deepEqual(
  missingEnglishDataKeys,
  [],
  `English settings dictionary is missing ${missingEnglishDataKeys.length} data keys:\n${missingEnglishDataKeys.join('\n')}`,
);
const missingItalianDataKeys = [...dataKeys].filter((key) => !IT[key]).sort((a, b) => a.localeCompare(b));
assert.deepEqual(
  missingItalianDataKeys,
  [],
  `Italian settings dictionary is missing ${missingItalianDataKeys.length} data keys:\n${missingItalianDataKeys.join('\n')}`,
);

console.log(`settingsCoverage.verify: ok (${settingsKeys.size} settings keys and ${dataKeys.size} settings data keys covered)`);
