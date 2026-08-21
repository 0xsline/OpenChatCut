import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function sourceFile(filePath) {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function unwrapExpression(node) {
  if (
    ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isParenthesizedExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function englishKeys() {
  const keys = new Set();
  for (const filePath of walk(EN_ROOT).filter((file) => file.endsWith('.ts'))) {
    const sf = sourceFile(filePath);
    const assignment = sf.statements.find((node) => ts.isExportAssignment(node));
    if (!assignment) continue;
    const expression = unwrapExpression(assignment.expression);
    if (!ts.isObjectLiteralExpression(expression)) continue;
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (ts.isStringLiteralLike(property.name)) keys.add(property.name.text);
    }
  }
  return keys;
}

function isInsideTranslation(node, sf) {
  for (let parent = node.parent; parent && parent !== sf; parent = parent.parent) {
    if (
      ts.isCallExpression(parent)
      && ts.isIdentifier(parent.expression)
      && (parent.expression.text === 't' || parent.expression.text === 'tData')
    ) {
      return true;
    }
  }
  return false;
}

function issue(sf, node, message) {
  const relative = path.relative(ROOT, sf.fileName);
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${relative}:${line + 1}:${character + 1} ${message}`;
}

function untranslatedLiterals(node, sf) {
  const literals = [];
  function visit(child) {
    const text = literalText(child);
    if (text && CJK.test(text) && !isInsideTranslation(child, sf)) {
      literals.push(child);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return literals;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return node.text;
  }
  return null;
}

function directlyRenderedLiterals(node, sf) {
  if (ts.isStringLiteralLike(node)) {
    return CJK.test(node.text) && !isInsideTranslation(node, sf) ? [node] : [];
  }
  if (ts.isParenthesizedExpression(node)) {
    return directlyRenderedLiterals(node.expression, sf);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...directlyRenderedLiterals(node.whenTrue, sf),
      ...directlyRenderedLiterals(node.whenFalse, sf),
    ];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...directlyRenderedLiterals(node.left, sf),
      ...directlyRenderedLiterals(node.right, sf),
    ];
  }
  if (ts.isTemplateExpression(node)) {
    const literals = CJK.test(node.head.text) && !isInsideTranslation(node.head, sf) ? [node.head] : [];
    for (const span of node.templateSpans) {
      literals.push(...directlyRenderedLiterals(span.expression, sf));
      if (CJK.test(span.literal.text) && !isInsideTranslation(span.literal, sf)) {
        literals.push(span.literal);
      }
    }
    return literals;
  }
  return [];
}

function collectInitializers(sf) {
  const initializers = new Map();
  function collectDeclarations(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const scope = declarationScope(node);
      const declarations = initializers.get(node.name.text) ?? [];
      declarations.push({ declaration: node, initializer: node.initializer, scope });
      initializers.set(node.name.text, declarations);
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sf);
  return initializers;
}

function declarationScope(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) return parent;
  }
  return node.getSourceFile();
}

function initializerFor(identifier, initializers) {
  const position = identifier.getStart();
  const candidates = (initializers.get(identifier.text) ?? [])
    .filter(({ declaration, scope }) => (
      declaration.getStart() < position
      && scope.getStart() <= position
      && position < scope.end
    ))
    .sort((a, b) => {
      const scopeDistance = (a.scope.end - a.scope.getStart()) - (b.scope.end - b.scope.getStart());
      return scopeDistance || b.declaration.getStart() - a.declaration.getStart();
    });
  return candidates[0]?.initializer;
}

function auditNativeAttribute(sf, node, initializers) {
  if (
    !ts.isJsxAttribute(node)
    || !USER_FACING_ATTRIBUTES.has(node.name.text)
    || !node.initializer
    || !/^[a-z]/.test(node.parent.parent.tagName.getText(sf))
  ) return [];
  const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
  if (!expression) return [];
  const literals = directlyRenderedLiterals(expression, sf);
  if (ts.isIdentifier(expression)) {
    const initializer = initializerFor(expression, initializers);
    if (initializer) literals.push(...untranslatedLiterals(initializer, sf));
  }
  return literals.map((literal) => (
    issue(sf, literal, `原生控件属性直接使用中文：${JSON.stringify(literal.text)}`)
  ));
}

function auditJsxExpression(sf, node, relative, initializers) {
  if (
    !ts.isJsxExpression(node)
    || !node.expression
    || (!ts.isJsxElement(node.parent) && !ts.isJsxFragment(node.parent))
  ) return [];
  const issues = directlyRenderedLiterals(node.expression, sf)
    .filter((literal) => !ALLOWED_RAW_RENDER_LITERALS.has(`${relative}::${literal.text}`))
    .map((literal) => issue(sf, literal, `JSX 表达式直接渲染中文：${JSON.stringify(literal.text)}`));
  if (!ts.isIdentifier(node.expression)) return issues;
  const initializer = initializerFor(node.expression, initializers);
  return [
    ...issues,
    ...(initializer ? untranslatedLiterals(initializer, sf) : [])
      .map((literal) => issue(sf, literal, `变量 ${node.expression.text} 直接渲染未翻译中文：${JSON.stringify(literal.text)}`)),
  ];
}

function auditUiFile(filePath, keys) {
  const sf = sourceFile(filePath);
  const relative = path.relative(ROOT, filePath);
  const initializers = collectInitializers(sf);
  const issues = [];
  function visit(node) {
    if (ts.isJsxText(node) && CJK.test(node.text.trim())) {
      issues.push(issue(sf, node, `直接渲染中文：${JSON.stringify(node.text.trim())}`));
    }
    issues.push(...auditNativeAttribute(sf, node, initializers));
    issues.push(...auditJsxExpression(sf, node, relative, initializers));
    if (
      ts.isStringLiteralLike(node)
      && CJK.test(node.text)
      && !isInsideTranslation(node, sf)
      && !keys.has(node.text)
      && !ALLOWED_DATA_LITERALS.has(`${relative}::${node.text}`)
    ) {
      issues.push(issue(sf, node, `未登记的中文 UI 字面量：${JSON.stringify(node.text)}`));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return issues;
}

const keys = englishKeys();
const sourceFiles = walk(SOURCE_ROOT).filter((filePath) => {
  if (!/\.tsx?$/.test(filePath)) return false;
  if (filePath.startsWith(path.join(SOURCE_ROOT, 'i18n'))) return false;
  const relative = path.relative(ROOT, filePath);
  return !isTestFile(relative);
});
const translationIssues = sourceFiles.flatMap((filePath) => {
  const sf = sourceFile(filePath);
  const issues = [];
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 't'
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
      && CJK.test(node.arguments[0].text)
      && !keys.has(node.arguments[0].text)
    ) {
      issues.push(issue(sf, node.arguments[0], `英文词典缺少：${JSON.stringify(node.arguments[0].text)}`));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return issues;
});
const uiFiles = walk(SOURCE_ROOT).filter((filePath) => {
  if (!filePath.endsWith('.tsx')) return false;
  const relative = path.relative(ROOT, filePath);
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
