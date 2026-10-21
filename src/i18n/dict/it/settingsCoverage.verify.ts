import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { EN } from '../en';
import { IT } from './index';
import { SETTINGS_CATEGORIES } from '../../../components/settings/settingsSchema';
import type { SettingsField, SettingsVendorPage } from '../../../components/settings/settingsFields';

const ROOT = process.cwd();
const SETTINGS_ROOT = path.join(ROOT, 'src', 'components', 'settings');
const CJK = /[\u3400-\u9fff]/;
const IGNORED_NODE_KEYS = new Set([
  'type', 'start', 'end', 'loc', 'range', 'extra',
  'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors',
  'interpreter', 'directives',
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

type BabelNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is BabelNode {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

function walkAst(node: BabelNode, visit: (node: BabelNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (IGNORED_NODE_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walkAst(child, visit);
    } else if (isNode(value)) {
      walkAst(value, visit);
    }
  }
}

function sourceFile(filePath: string): BabelNode {
  const ast = parse(fs.readFileSync(filePath, 'utf8'), {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: filePath.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    createParenthesizedExpressions: true,
  });
  // Parser boundary: the parser's File/Program types are declared in @babel/types;
  // this scan only needs the generic node shape.
  return ast.program as unknown as BabelNode;
}

function literalText(node: BabelNode): string | null {
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const first = quasis[0];
    if (isNode(first) && first.type === 'TemplateElement') {
      const firstValue = first.value;
      if (
        firstValue !== null
        && typeof firstValue === 'object'
        && 'cooked' in firstValue
        && typeof firstValue.cooked === 'string'
      ) {
        return firstValue.cooked;
      }
    }
  }
  return null;
}

const settingsKeys = new Set<string>();
for (const filePath of walk(SETTINGS_ROOT).filter((file) => /\.tsx?$/.test(file) && !/\.verify\.tsx?$/.test(file))) {
  const ast = sourceFile(filePath);
  walkAst(ast, (node) => {
    const text = literalText(node);
    if (text && CJK.test(text) && EN[text]) settingsKeys.add(text);
  });
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
