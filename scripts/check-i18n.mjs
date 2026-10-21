import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(ROOT, 'src');
const EN_ROOT = path.join(SOURCE_ROOT, 'i18n', 'dict', 'en');
const CJK = /[\u3400-\u9fff]/;
// Test files (*.verify.ts/tsx, *.check.ts) are exempt: their Chinese literals are
// assertion messages / CLI output, not user-facing UI copy (see AGENTS.md console.log rule).
const isTestFile = (relative) => /\.(verify|check)\.(tsx?|mjs)$/.test(relative);
const SKIPPED_UI_FILES = new Set([
  'src/captions/CaptionsLayer.tsx',
]);
const ALLOWED_DATA_LITERALS = new Set([
  'src/App.tsx::示例工程',
  'src/captions/CaptionStyleMenu.tsx::日本語',
  'src/captions/CaptionsControls.tsx::日本語',
  'src/components/timeline/TimelineTabs.tsx::竖屏',
  // VisionModelPane MODES data constants: Chinese originals translated at
  // render time via t(mode.label) / t(mode.hint) — see the component.
  'src/components/settings/VisionModelPane.tsx::跟随主模型',
  'src/components/settings/VisionModelPane.tsx::主模型不支持图片时维持现状（图片剥离为文本）。',
  'src/components/settings/VisionModelPane.tsx::指定视觉模型',
  'src/components/settings/VisionModelPane.tsx::图片与时间线帧由所选视觉模型理解后以文本注入。',
  'src/components/settings/VisionModelPane.tsx::禁用',
  'src/components/settings/VisionModelPane.tsx::不描述图片，一律剥离。',
  'src/components/settings/VisionModelPane.tsx::xAI (订阅登录)',
]);
const ALLOWED_RAW_RENDER_LITERALS = new Set([
  'src/components/TopBar.tsx::中',
]);
const USER_FACING_ATTRIBUTES = new Set(['alt', 'aria-label', 'placeholder', 'title']);

const IGNORED_NODE_KEYS = new Set([
  'type', 'start', 'end', 'loc', 'range', 'extra',
  'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors',
  'interpreter', 'directives',
]);

function relativeSourcePath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function isNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.type === 'string';
}

function forEachChild(node, visit) {
  for (const key of Object.keys(node)) {
    if (IGNORED_NODE_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) visit(child);
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

function buildParents(ast) {
  const parents = new WeakMap();
  const visit = (node) => {
    forEachChild(node, (child) => {
      parents.set(child, node);
      visit(child);
    });
  };
  visit(ast);
  return parents;
}

function sourceFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: filePath,
    plugins: filePath.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    createParenthesizedExpressions: true,
  });
  return { filePath, code, ast, parents: buildParents(ast) };
}

function walkAll(node, visit) {
  visit(node);
  forEachChild(node, (child) => walkAll(child, visit));
}

function isStringLiteralLike(node) {
  return node.type === 'StringLiteral'
    || (node.type === 'TemplateLiteral' && node.expressions.length === 0);
}

function literalText(node) {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateElement') return node.value.cooked ?? node.value.raw;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? '';
  }
  return null;
}

function unwrapExpression(node) {
  while (
    node
    && (node.type === 'TSAsExpression'
      || node.type === 'TSSatisfiesExpression'
      || node.type === 'ParenthesizedExpression')
  ) {
    node = node.expression;
  }
  return node;
}

function englishKeys() {
  const keys = new Set();
  for (const filePath of walk(EN_ROOT).filter((file) => file.endsWith('.ts'))) {
    const { ast } = sourceFile(filePath);
    const declaration = ast.program.body.find((node) => (
      node.type === 'ExportDefaultDeclaration' || node.type === 'TSExportAssignment'
    ));
    if (!declaration) continue;
    const expression = unwrapExpression(
      declaration.type === 'ExportDefaultDeclaration' ? declaration.declaration : declaration.expression,
    );
    if (!expression || expression.type !== 'ObjectExpression') continue;
    for (const property of expression.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) continue;
      if (property.key.type === 'StringLiteral') keys.add(property.key.value);
    }
  }
  return keys;
}

function isInsideTranslation(file, node) {
  for (let parent = file.parents.get(node); parent; parent = file.parents.get(parent)) {
    if (
      parent.type === 'CallExpression'
      && parent.callee.type === 'Identifier'
      && (parent.callee.name === 't' || parent.callee.name === 'tData')
    ) {
      return true;
    }
  }
  return false;
}

function issue(file, node, message) {
  const relative = relativeSourcePath(file.filePath);
  const { line, column } = node.loc.start;
  return `${relative}:${line}:${column + 1} ${message}`;
}

function untranslatedLiterals(file, node) {
  const literals = [];
  const visit = (child) => {
    const text = literalText(child);
    if (text && CJK.test(text) && !isInsideTranslation(file, child)) {
      literals.push(child);
    }
    forEachChild(child, visit);
  };
  visit(node);
  return literals;
}

function directlyRenderedLiterals(file, node) {
  const text = literalText(node);
  if (text !== null) {
    return CJK.test(text) && !isInsideTranslation(file, node) ? [node] : [];
  }
  if (node.type === 'ParenthesizedExpression') {
    return directlyRenderedLiterals(file, node.expression);
  }
  if (node.type === 'ConditionalExpression') {
    return [
      ...directlyRenderedLiterals(file, node.consequent),
      ...directlyRenderedLiterals(file, node.alternate),
    ];
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return [
      ...directlyRenderedLiterals(file, node.left),
      ...directlyRenderedLiterals(file, node.right),
    ];
  }
  if (node.type === 'TemplateLiteral') {
    const literals = [];
    for (const quasi of node.quasis) {
      const quasiText = literalText(quasi);
      if (quasiText && CJK.test(quasiText) && !isInsideTranslation(file, quasi)) {
        literals.push(quasi);
      }
    }
    for (const expression of node.expressions) {
      literals.push(...directlyRenderedLiterals(file, expression));
    }
    return literals;
  }
  return [];
}

function collectInitializers(file) {
  const initializers = new Map();
  walkAll(file.ast, (node) => {
    if (
      node.type === 'VariableDeclarator'
      && node.id.type === 'Identifier'
      && node.init
    ) {
      const scope = declarationScope(file, node);
      const declarations = initializers.get(node.id.name) ?? [];
      declarations.push({ declaration: node, initializer: node.init, scope });
      initializers.set(node.id.name, declarations);
    }
  });
  return initializers;
}

function declarationScope(file, node) {
  for (let parent = file.parents.get(node); parent; parent = file.parents.get(parent)) {
    if (parent.type === 'BlockStatement' || parent.type === 'Program') return parent;
  }
  return file.ast.program;
}

function initializerFor(identifier, initializers) {
  const position = identifier.start;
  const candidates = (initializers.get(identifier.name) ?? [])
    .filter(({ declaration, scope }) => (
      declaration.start < position
      && scope.start <= position
      && position < scope.end
    ))
    .sort((a, b) => {
      const scopeDistance = (a.scope.end - a.scope.start) - (b.scope.end - b.scope.start);
      return scopeDistance || b.declaration.start - a.declaration.start;
    });
  return candidates[0]?.initializer;
}

function auditNativeAttribute(file, node, initializers) {
  if (node.type !== 'JSXAttribute' || node.name.type !== 'JSXIdentifier') return [];
  if (!USER_FACING_ATTRIBUTES.has(node.name.name) || !node.value) return [];
  const opening = file.parents.get(node);
  const tagName = opening?.type === 'JSXOpeningElement' ? opening.name : null;
  if (!tagName || !/^[a-z]/.test(file.code.slice(tagName.start, tagName.end))) return [];
  const expression = node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value;
  if (!expression) return [];
  const literals = directlyRenderedLiterals(file, expression);
  if (expression.type === 'Identifier') {
    const initializer = initializerFor(expression, initializers);
    if (initializer) literals.push(...untranslatedLiterals(file, initializer));
  }
  return literals.map((literal) => (
    issue(file, literal, `原生控件属性直接使用中文：${JSON.stringify(literalText(literal))}`)
  ));
}

function auditJsxExpression(file, node, relative, initializers) {
  if (node.type !== 'JSXExpressionContainer' || !node.expression) return [];
  const parent = file.parents.get(node);
  if (parent?.type !== 'JSXElement' && parent?.type !== 'JSXFragment') return [];
  const issues = directlyRenderedLiterals(file, node.expression)
    .filter((literal) => !ALLOWED_RAW_RENDER_LITERALS.has(`${relative}::${literalText(literal)}`))
    .map((literal) => issue(file, literal, `JSX 表达式直接渲染中文：${JSON.stringify(literalText(literal))}`));
  if (node.expression.type !== 'Identifier') return issues;
  const initializer = initializerFor(node.expression, initializers);
  return [
    ...issues,
    ...(initializer ? untranslatedLiterals(file, initializer) : [])
      .map((literal) => issue(file, literal, `变量 ${node.expression.name} 直接渲染未翻译中文：${JSON.stringify(literalText(literal))}`)),
  ];
}

function auditUiFile(filePath, keys) {
  const file = sourceFile(filePath);
  const relative = relativeSourcePath(filePath);
  const initializers = collectInitializers(file);
  const issues = [];
  walkAll(file.ast, (node) => {
    if (node.type === 'JSXText' && CJK.test(node.value.trim())) {
      issues.push(issue(file, node, `直接渲染中文：${JSON.stringify(node.value.trim())}`));
    }
    issues.push(...auditNativeAttribute(file, node, initializers));
    issues.push(...auditJsxExpression(file, node, relative, initializers));
    if (isStringLiteralLike(node)) {
      const text = literalText(node);
      if (
        text
        && CJK.test(text)
        && !isInsideTranslation(file, node)
        && !keys.has(text)
        && !ALLOWED_DATA_LITERALS.has(`${relative}::${text}`)
      ) {
        issues.push(issue(file, node, `未登记的中文 UI 字面量：${JSON.stringify(text)}`));
      }
    }
  });
  return issues;
}

const keys = englishKeys();
const sourceFiles = walk(SOURCE_ROOT).filter((filePath) => {
  if (!/\.tsx?$/.test(filePath)) return false;
  if (filePath.startsWith(path.join(SOURCE_ROOT, 'i18n'))) return false;
  const relative = relativeSourcePath(filePath);
  return !isTestFile(relative);
});
const translationIssues = sourceFiles.flatMap((filePath) => {
  const file = sourceFile(filePath);
  const issues = [];
  walkAll(file.ast, (node) => {
    if (
      node.type === 'CallExpression'
      && node.callee.type === 'Identifier'
      && node.callee.name === 't'
      && node.arguments[0]
      && isStringLiteralLike(node.arguments[0])
    ) {
      const text = literalText(node.arguments[0]);
      if (text && CJK.test(text) && !keys.has(text)) {
        issues.push(issue(file, node.arguments[0], `英文词典缺少：${JSON.stringify(text)}`));
      }
    }
  });
  return issues;
});
const uiFiles = walk(SOURCE_ROOT).filter((filePath) => {
  if (!filePath.endsWith('.tsx')) return false;
  const relative = relativeSourcePath(filePath);
  if (SKIPPED_UI_FILES.has(relative)) return false;
  if (relative.startsWith('src/editor/')) return false;
  return !isTestFile(relative);
});
const issues = [
  ...translationIssues,
  ...uiFiles.flatMap((filePath) => auditUiFile(filePath, keys)),
];

if (issues.length > 0) {
  console.error(`i18n 校验失败（${issues.length} 项）：`);
  console.error(issues.join('\n'));
  process.exit(1);
}

console.log(`i18n 校验通过：${uiFiles.length} 个 UI 文件，${keys.size} 个英文词条`);
