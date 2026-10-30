import { parseDocument, DomUtils } from 'htmlparser2';

export const DEFAULT_CONFIG = Object.freeze({
  defaultLocale: 'zh-CN',
  localeDirs: Object.freeze(['src/locales', 'src/i18n', 'locales', 'i18n']),
  inlayHints: Object.freeze({ enabled: true, maxLength: 24 }),
  rawTextDiagnostics: false,
  packages: Object.freeze([]),
});

export const CONFIG_RELATIVE_PATH = '.zed/i18nlensrc.json';

const TRANSLATABLE_ATTRIBUTES = new Set(['title', 'alt', 'placeholder', 'label', 'aria-label']);
const RAW_TEXT_SKIPPED_TAGS = new Set(['script', 'style', 'code', 'pre', 'i18n', 'i18n-t', 'i18nt', 'trans']);

function isExcludedTemplateNode(node) {
  const attrs = node.attribs || {};
  return node.type === 'comment' || RAW_TEXT_SKIPPED_TAGS.has(node.name)
    || attrs.translate?.toLowerCase() === 'no'
    || Object.keys(attrs).some((name) => /^(?:v-t(?:\.|$)|v-pre$|v-html$|v-text$)/.test(name));
}

function isVueHtmlTemplate(node) {
  return node.name === 'template' && !Object.hasOwn(node.attribs || {}, 'src')
    && (!node.attribs?.lang || /^html$/i.test(node.attribs.lang));
}

function templateInterpolations(text, excludedRanges) {
  const ranges = [];
  let cursor = 0;
  while ((cursor = text.indexOf('{{', cursor)) !== -1) {
    const excluded = excludedRanges.find(({ start, end }) => cursor >= start && cursor < end);
    if (excluded) {
      cursor = excluded.end;
      continue;
    }
    const start = cursor;
    cursor += 2;
    let quote;
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quote) {
        if (char === '\\') cursor++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (text.startsWith('/*', cursor)) {
        const end = text.indexOf('*/', cursor + 2);
        cursor = end === -1 ? text.length : end + 1;
      } else if (text.startsWith('//', cursor)) {
        const end = text.indexOf('\n', cursor + 2);
        cursor = end === -1 ? text.length : end;
      } else if (char === '{') {
        depth++;
      } else if (char === '}' && depth > 0) {
        depth--;
      } else if (text.startsWith('}}', cursor)) {
        cursor += 2;
        break;
      }
    }
    ranges.push({ start, end: Math.min(cursor, text.length) });
  }
  return ranges;
}

// Intentionally conservative: natural-language candidates, not arbitrary strings
// or a dictionary. Single title-cased labels and non-Latin text are useful too.
export function isLikelyUserFacingText(value, loose = false) {
  const text = value.trim();
  if (!/\p{L}/u.test(text)) return false;
  if (/^(?:https?:|mailto:|www\.|[/#])|\S+@\S+\.\S+/i.test(text)) return false;
  if (/^[\w.-]+(?:[/\\][\w.-]+)+$|^[\w-]+(?:\.[\w-]+)+$/.test(text)) return false;
  // Extraction is user-triggered: any remaining text with letters qualifies.
  if (loose) return true;
  if (/^[A-Z\d_-]+$|^[a-z\d]+(?:[_-][a-z\d]+)+$|^[a-z]+(?:[A-Z][a-z\d]*)+$/.test(text)) return false;
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\p{M}\s]/u.test(text)) return true;
  return (/\s/.test(text) && (text.match(/\p{L}[\p{L}\p{M}]*/gu) || []).length >= 2)
    || /^\p{Lu}\p{Ll}{2,}[.!?…]?$/u.test(text);
}

/**
 * Detect only template text/attributes. Parser indices and JS string offsets are
 * UTF-16, matching LSP positions. Mask Vue expressions before HTML parsing so
 * comparisons and string literals inside {{ ... }} cannot become markup.
 */
export function getRawTextDiagnostics(text, language, enabled = false, loose = false) {
  if (!enabled || !['vue', 'html'].includes(language)) return [];
  const parserOptions = { withStartIndices: true, withEndIndices: true, recognizeSelfClosing: true };
  // An unmatched "{{" in a comment, script, style or custom SFC block must
  // never mask the template that follows it. Let the HTML parser locate these.
  const excludedRanges = [];
  function excludeNonTemplate(node, topLevel = false) {
    if (isExcludedTemplateNode(node)
      || (language === 'vue' && topLevel && node.name && !isVueHtmlTemplate(node))) {
      excludedRanges.push({ start: node.startIndex, end: node.endIndex + 1 });
      return;
    }
    for (const child of node.children || []) excludeNonTemplate(child);
  }
  for (const node of parseDocument(text, parserOptions).children) excludeNonTemplate(node, true);
  const interpolations = templateInterpolations(text, excludedRanges);
  let previous = 0;
  const masked = interpolations.map(({ start, end }) => {
    const part = text.slice(previous, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ');
    previous = end;
    return part;
  }).join('') + text.slice(previous);
  const document = parseDocument(masked, parserOptions);
  const diagnostics = [];
  const calls = extractI18nKeys(text);
  function report(raw, start, value = raw) {
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.trimEnd().length;
    if (calls.some((c) => c.call && c.call.start <= start + leading && start + trailing <= c.call.end)) return;
    if (!isLikelyUserFacingText(value, loose)) return;
    diagnostics.push({
      range: makeRange(text, start + leading, start + trailing),
      severity: 2,
      code: 'raw-text',
      source: 'i18n-lens',
      message: 'Potential untranslated text: ' + JSON.stringify(value.trim()),
    });
  }
  function visit(node) {
    if (node.type === 'text') {
      const raw = text.slice(node.startIndex, node.endIndex + 1);
      // Report each literal part separately, never an interpolation expression.
      let cursor = 0;
      for (const { start, end } of interpolations) {
        if (end <= node.startIndex || start > node.endIndex) continue;
        const part = raw.slice(cursor, Math.max(0, start - node.startIndex));
        report(part, node.startIndex + cursor, DomUtils.textContent(parseDocument(part)));
        cursor = Math.min(raw.length, end - node.startIndex);
      }
      const part = raw.slice(cursor);
      report(part, node.startIndex + cursor, DomUtils.textContent(parseDocument(part)));
      return;
    }
    if (!node.name) return;
    const attrs = node.attribs || {};
    if (isExcludedTemplateNode(node)) return;
    // HTML parser determines element boundaries; this small lexer only recovers
    // exact source spans for attributes (including quoted > characters).
    const opening = /^<[^\s/>]+((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(text.slice(node.startIndex));
    if (opening) {
      const prefixLength = opening[0].length - opening[1].length - 1;
      for (const match of opening[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const name = match[1].toLowerCase();
        const bound = name.startsWith(':') || name.startsWith('v-bind:');
        const target = bound ? name.replace(/^(?::|v-bind:)/, '') : name;
        if (!TRANSLATABLE_ATTRIBUTES.has(target) || !match[0].includes('=')) continue;
        let raw = match[2] ?? match[3] ?? match[4] ?? '';
        if (raw.includes('{{')) continue;
        const valuePrefix = /^[^=]+=\s*["']?/.exec(match[0])[0].length;
        let start = node.startIndex + prefixLength + match.index + valuePrefix;
        let value = attrs[name] ?? raw;
        if (bound) {
          // No JS parsing: only a whole, unescaped quoted string is safe.
          const literal = /^\s*(['"])([^\\\r\n]*?)\1\s*$/.exec(raw);
          const decodedLiteral = /^\s*(['"])([^\\\r\n]*?)\1\s*$/.exec(value);
          if (!literal || literal[2].includes(literal[1])
            || !decodedLiteral || decodedLiteral[2].includes(decodedLiteral[1])) continue;
          start += raw.indexOf(literal[1]) + 1;
          raw = literal[2];
          value = decodedLiteral[2];
        }
        report(raw, start, value);
      }
    }
    for (const child of node.children || []) visit(child);
  }
  if (language === 'vue') {
    for (const node of document.children) {
      if (!isVueHtmlTemplate(node) || isExcludedTemplateNode(node)) continue;
      for (const child of node.children || []) visit(child);
    }
  } else {
    for (const node of document.children) visit(node);
  }
  return diagnostics;
}

export function resolveConfigPath(workspaceRoot) {
  return joinFsPath(normalizeFsPath(workspaceRoot), CONFIG_RELATIVE_PATH);
}

export function normalizeI18nLensConfig(raw = {}) {
  const base = normalizeProjectConfig(raw, DEFAULT_CONFIG);
  const packages = Array.isArray(raw.packages)
    ? raw.packages
      .map((pkg) => normalizePackageConfig(pkg, base))
      .filter(Boolean)
    : [];

  return { ...base, packages };
}

export function mergeI18nLensConfig(base = {}, override = {}) {
  return {
    ...base,
    ...override,
    inlayHints: {
      ...((base && typeof base.inlayHints === 'object') ? base.inlayHints : {}),
      ...((override && typeof override.inlayHints === 'object') ? override.inlayHints : {}),
    },
    packages: Array.isArray(override?.packages) ? override.packages : base?.packages,
  };
}

function normalizeProjectConfig(raw = {}, defaults = DEFAULT_CONFIG) {
  const defaultLocale = typeof raw.defaultLocale === 'string' && raw.defaultLocale.trim()
    ? raw.defaultLocale.trim()
    : defaults.defaultLocale;

  const localeDirs = Array.isArray(raw.localeDirs)
    ? raw.localeDirs.filter((dir) => typeof dir === 'string' && dir.trim()).map((dir) => normalizeRelativePath(dir.trim()))
    : [];

  const defaultInlayHints = defaults.inlayHints || DEFAULT_CONFIG.inlayHints;
  const rawInlayHints = raw.inlayHints && typeof raw.inlayHints === 'object' ? raw.inlayHints : {};
  const enabled = typeof rawInlayHints.enabled === 'boolean' ? rawInlayHints.enabled : defaultInlayHints.enabled;
  const maxLength = Number.isInteger(rawInlayHints.maxLength) && rawInlayHints.maxLength > 0
    ? rawInlayHints.maxLength
    : defaultInlayHints.maxLength;

  return {
    defaultLocale,
    localeDirs: localeDirs.length > 0 ? localeDirs : [...defaults.localeDirs],
    inlayHints: { enabled, maxLength },
    rawTextDiagnostics: typeof raw.rawTextDiagnostics === 'boolean' ? raw.rawTextDiagnostics : defaults.rawTextDiagnostics,
  };
}

function normalizePackageConfig(raw, inherited) {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = typeof raw.root === 'string' && raw.root.trim()
    ? normalizeRelativePath(raw.root.trim())
    : undefined;
  if (!root) return undefined;
  return { root, ...normalizeProjectConfig(raw, inherited) };
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
}

export function resolveProjectContext(filePath, workspaceRoot, config) {
  const normalizedWorkspaceRoot = normalizeFsPath(workspaceRoot);
  const normalizedFilePath = normalizeFsPath(filePath);
  const candidates = [
    { root: normalizedWorkspaceRoot, config: withoutPackages(config) },
    ...((config?.packages || []).map((pkg) => ({
      root: normalizeFsPath(joinFsPath(normalizedWorkspaceRoot, pkg.root)),
      config: withoutPackages(pkg),
    }))),
  ];

  return candidates
    .filter((candidate) => isPathInside(normalizedFilePath, candidate.root))
    .sort((a, b) => b.root.length - a.root.length)[0] || candidates[0];
}

function withoutPackages(config) {
  const { packages: _packages, ...rest } = config || normalizeI18nLensConfig();
  return rest;
}

function normalizeFsPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function joinFsPath(root, relative) {
  return root + '/' + normalizeRelativePath(relative || '');
}

function isPathInside(filePath, root) {
  return filePath === root || filePath.startsWith(root + '/');
}


export function didWatchedFileChange(previous, current) {
  return previous?.mtimeMs !== current?.mtimeMs;
}

export function flattenLocale(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? prefix + '.' + key : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenLocale(child, fullKey, out);
    else out[fullKey] = String(child);
  }
  return out;
}

export function getValueByKey(obj, key) {
  return key.split('.').reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), obj);
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function makeRange(text, start, end) {
  return { start: offsetToPosition(text, start), end: offsetToPosition(text, end) };
}
// Lexical mask over mixed Vue/TS/JSX text: returns opaque ranges (comments,
// plain strings, template-literal raw text, HTML comments, ordinary attribute
// values) plus interiors of plain HTML/JSX attributes. Those interiors look
// like `title="$t('…')"` but are static text, not real calls — extractI18nKeys
// skips them unless includeStaticAttrCalls (Inline only). Vue directive
// attribute values (`:x="…"`, `v-x="…"`, `@x="…"`, `#x="…"`) and `${…}`
// interpolations stay transparent. Best-effort lexing only — no AST.
function computeOpaqueRanges(text) {
  const ranges = [];
  const attrValues = [];
  const stack = [{ type: 'code' }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < text.length) {
    const f = top();
    const ch = text[i];
    if (f.type === 'lineComment') {
      if (ch === '\n') { ranges.push({ start: f.start, end: i }); stack.pop(); }
      i++;
      continue;
    }
    if (f.type === 'blockComment') {
      if (ch === '*' && text[i + 1] === '/') { ranges.push({ start: f.start, end: i + 2 }); stack.pop(); i += 2; continue; }
      i++;
      continue;
    }
    if (f.type === 'htmlComment') {
      if (ch === '-' && text[i + 1] === '-' && text[i + 2] === '>') { ranges.push({ start: f.start, end: i + 3 }); stack.pop(); i += 3; continue; }
      i++;
      continue;
    }
    if (f.type === 'string') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === f.quote) {
        ranges.push({ start: f.start, end: i + 1 });
        if (f.attrValue) attrValues.push({ start: f.start + 1, end: i });
        stack.pop();
      }
      i++;
      continue;
    }
    if (f.type === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { ranges.push({ start: f.start, end: i + 1 }); stack.pop(); i++; continue; }
      if (ch === '$' && text[i + 1] === '{') {
        ranges.push({ start: f.start, end: i });
        stack.pop();
        stack.push({ type: 'templateExpr', depth: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // code-like frames: code, templateExpr, attrExpr
    if (f.type === 'attrExpr' && f.depth === 0 && ch === f.quote) { stack.pop(); i++; continue; }
    if (ch === '{') {
      if (f.type === 'templateExpr' || f.type === 'attrExpr') f.depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      if (f.type === 'templateExpr') {
        if (f.depth === 0) { stack.pop(); stack.push({ type: 'template', start: i + 1 }); }
        else f.depth--;
      } else if (f.type === 'attrExpr' && f.depth > 0) f.depth--;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { stack.push({ type: 'lineComment', start: i }); i += 2; continue; }
    if (ch === '/' && text[i + 1] === '*') { stack.push({ type: 'blockComment', start: i }); i += 2; continue; }
    if (ch === '<' && text[i + 1] === '!' && text[i + 2] === '-' && text[i + 3] === '-') { stack.push({ type: 'htmlComment', start: i }); i += 4; continue; }
    if (ch === '"' || ch === "'") {
      if (f.type === 'code' && isAttrExprQuote(text, i)) stack.push({ type: 'attrExpr', quote: ch, depth: 0 });
      else stack.push({ type: 'string', quote: ch, start: i, attrValue: f.type === 'code' && isPlainAttrQuote(text, i) });
      i++;
      continue;
    }
    if (ch === '`') { stack.push({ type: 'template', start: i }); i++; continue; }
    i++;
  }
  while (stack.length > 1) {
    const f = stack.pop();
    if (f.start === undefined) continue;
    ranges.push({ start: f.start, end: text.length });
    if (f.attrValue) attrValues.push({ start: f.start + 1, end: text.length });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return { ranges, attrValues };
}

// A quote is a Vue directive attribute opener when preceded by `name=` where
// name is `:foo`, `@foo`, `#foo`, `v-foo`, or `ns:foo` (v-on:, v-bind:, …).
function isAttrExprQuote(text, quoteOffset) {
  const before = text.slice(Math.max(0, quoteOffset - 200), quoteOffset);
  return /(?:^|[\s<"'`])(?:[:@#][\w.:[\]-]*|[\w-]+:[\w.:[\]-]*|v-[\w.:[\]-]*)\s*=\s*$/.test(before);
}

// Plain HTML/JSX attributes (`title="…"`, `alt='…'`) stay opaque as strings so
// apostrophes in values cannot swallow later code. Lookalike t() text inside
// them is not a real call (see extractI18nKeys includeStaticAttrCalls).
function isPlainAttrQuote(text, quoteOffset) {
  const before = text.slice(0, quoteOffset);
  const lastLt = before.lastIndexOf('<');
  const lastGt = before.lastIndexOf('>');
  if (lastLt < 0 || lastLt < lastGt || !/^[A-Za-z]/.test(before.slice(lastLt + 1))) return false;
  return /(?:^|[\s"'`/])[\w.:[\]-]+\s*=\s*$/.test(before.slice(-80));
}

function isOpaque(ranges, offset) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}


export function extractI18nKeys(text, { includeStaticAttrCalls = false } = {}) {
  const found = [];
  const { ranges: opaque, attrValues } = computeOpaqueRanges(text);
  collectFunctionCallKeys(text, found, opaque, includeStaticAttrCalls ? attrValues : []);
  collectFormatMessageKeys(text, found, opaque);
  const patterns = [
    // <i18n-t keypath="key"> (Vue I18n) and <Trans i18nKey="key"> (react-i18next)
    /\b(?:keypath|i18nKey)\s*=\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
    /\bv-t\s*=\s*"'([A-Za-z0-9_.:-]+)'"/g,
    /\bv-t\s*=\s*'"([A-Za-z0-9_.:-]+)"'/g,
    /\bv-t\s*=\s*"\s*\{\s*path\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const before = text[match.index - 1];
      // Literal attribute only — bound directives (`:keypath`, `@`, `#`, `.prop`)
      // hold expressions handled by the call scanner, not a literal key.
      if (before !== undefined && /[\w:@#.-]/.test(before)) continue;
      if (isOpaque(opaque, match.index)) continue;
      const key = match[2] || match[1];
      const keyOffsetInMatch = match[0].lastIndexOf(key);
      const start = match.index + keyOffsetInMatch;
      const end = start + key.length;
      found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end });
    }
  }
  found.sort((a, b) => a.startOffset - b.startOffset);
  return found;
}

function collectFunctionCallKeys(text, found, opaque, attrValues = []) {
  // t/$t/tc/$tc/i18n.t/i18n.tc(...) — function calls, incl. Vue I18n plural tc
  const re = /(?:\x24tc?|\btc?|\bi18n\.tc?)\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    const parenOffset = re.lastIndex - 1;
    if (/[\w$]/.test(text[match.index - 1] || '')) continue;
    const inAttr = attrValues.some((r) => match.index >= r.start && match.index < r.end);
    if (!inAttr && isOpaque(opaque, match.index)) continue;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    // First arg must be exactly one string literal — dynamic keys like
    // `t('prefix.' + name)` are skipped, never half-matched.
    const keyMatch = callText.match(/^\(\s*(['"])([A-Za-z0-9_.:-]+)\1(?=\s*[,)])/);
    if (!keyMatch) continue;
    const key = keyMatch[2];
    const start = parenOffset + keyMatch[0].indexOf(key);
    const end = start + key.length;
    const args = splitArgsWithOffsets(callText.slice(1, -1));
    const paramsEdit = getParamsEdit(args.slice(1), parenOffset + 1, parenOffset + callText.length - 1);
    const paramsObject = extractParamsObject(args.slice(1), parenOffset + 1);
    found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end, providedParams: collectParamNames(args.slice(1)), paramsEdit, paramsObject,
      call: { start: match.index, end: parenOffset + callText.length, argCount: args.length, quote: keyMatch[1] } });
  }
}

function collectFormatMessageKeys(text, found, opaque) {
  const re = /\bformatMessage\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    if (/[\w$]/.test(text[match.index - 1] || '')) continue;
    if (isOpaque(opaque, match.index)) continue;
    const parenOffset = re.lastIndex - 1;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    const args = splitArgsWithOffsets(callText.slice(1, -1));
    const idArg = args[0]?.text || '';
    const keyMatch = idArg.match(/\bid\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1(?=\s*[,}])/);
    if (!keyMatch) continue;
    const key = keyMatch[2];
    const start = parenOffset + 1 + args[0].start + keyMatch.index + keyMatch[0].lastIndexOf(key);
    const end = start + key.length;
    const paramsEdit = getParamsEdit(args.slice(1), parenOffset + 1, parenOffset + callText.length - 1);
    const paramsObject = extractParamsObject(args.slice(1), parenOffset + 1);
    found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end, providedParams: collectParamNames(args.slice(1)), paramsEdit, paramsObject });
  }
}

// Read a balanced (...) starting at `start`.
function readParens(text, start) {
  if (text[start] !== '(') return undefined;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      if (end < 0) return undefined;
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function splitArgs(text) {
  const args = [];
  let start = 0, depth = 0, quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function splitArgsWithOffsets(text) {
  const args = [];
  let start = 0, depth = 0, quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { args.push(trimArg(text, start, i)); start = i + 1; }
  }
  const last = trimArg(text, start, text.length);
  if (last.text) args.push(last);
  return args;
}

function trimArg(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), start, end };
}

function getParamsEdit(args, argsStartOffset, closingParenOffset) {
  const objectArg = args.find((arg) => arg.text.startsWith('{') && arg.text.lastIndexOf('}') > 0);
  if (objectArg) {
    const closeBrace = objectArg.text.lastIndexOf('}');
    let insertAt = closeBrace;
    while (insertAt > 1 && /\s/.test(objectArg.text[insertAt - 1])) insertAt--;
    const body = objectArg.text.slice(1, insertAt);
    return { insertOffset: argsStartOffset + objectArg.start + insertAt, prefix: body.trim() ? ', ' : ' ' };
  }
  return { insertOffset: closingParenOffset, prefix: ', { ', suffix: ' }' };
}

function collectParamNames(args) {
  const params = new Set();
  for (const arg of args) {
    const trimmed = (typeof arg === 'string' ? arg : arg.text).trim();
    if (!trimmed.startsWith('{')) continue;
    const body = trimmed.slice(1, trimmed.lastIndexOf('}'));
    for (const part of splitArgs(body)) {
      const name = paramNameOf(part);
      if (name) params.add(name);
    }
  }
  return [...params].sort();
}

function paramNameOf(part) {
  const trimmed = String(part).trim();
  if (trimmed.startsWith('...')) return undefined;
  const m = trimmed.match(/^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*(?::|$)/);
  return (m && (m[1] || m[2])) || undefined;
}

// Absolute span of the params object literal plus each top-level property's raw
// text, so a code action can rebuild the object with unused params removed.
function extractParamsObject(args, argsStartOffset) {
  const objectArg = args.find((arg) => arg.text.startsWith('{') && arg.text.lastIndexOf('}') > 0);
  if (!objectArg) return undefined;
  const start = argsStartOffset + objectArg.start;
  const body = objectArg.text.slice(1, objectArg.text.lastIndexOf('}'));
  const props = splitArgsWithOffsets(body).map((part) => ({ name: paramNameOf(part.text), text: part.text }));
  return { start, end: start + objectArg.text.length, props };
}

export function keyAtPosition(text, position) {
  const offset = positionToOffset(text, position);
  return extractI18nKeys(text).find((item) => item.startOffset <= offset && offset <= item.endOffset);
}

// Reverse of Go to Definition: every range in `text` (source code) that uses `key`.
export function findCodeKeyRanges(text, key) {
  return extractI18nKeys(text).filter((item) => item.key === key).map((item) => item.range);
}

export function positionToOffset(text, position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line; i++) offset += (lines[i] || '').length + 1;
  return offset + position.character;
}


export function collectLocaleWatchPaths(localeCache, localeDirs = []) {
  const paths = new Set(localeDirs.filter(Boolean));
  for (const locale of Object.values(localeCache || {})) {
    if (locale.path) paths.add(locale.path);
    for (const file of locale.files || []) paths.add(file);
  }
  return [...paths].sort();
}

export function findLocaleKeyTarget(locale, key, localeTexts = {}) {
  if (!locale || !Object.prototype.hasOwnProperty.call(locale.flat || {}, key)) return undefined;
  // Namespace specificity does not determine which file won during loading.
  const filePath = locale.keyFiles?.[key];
  if (!filePath) return undefined;
  const lookupKey = lookupKeyForLocaleFile(locale, filePath, key);
  if (lookupKey === undefined) return undefined;
  const text = localeTexts[filePath];
  const range = text ? localeKeyRange(text, lookupKey, /\.json$/i.test(filePath)) : undefined;
  return range ? { filePath, position: range.start, range } : { filePath };
}

function lookupKeyForLocaleFile(locale, filePath, key) {
  const prefix = locale.filePrefixes?.[filePath];
  if (prefix !== undefined) {
    if (!prefix) return key;
    return key.startsWith(prefix + '.') ? key.slice(prefix.length + 1) : undefined;
  }
  const isNestedLocaleFile = !locale.topLevelFiles?.includes(filePath) && normalizeFsPath(locale.path) !== normalizeFsPath(filePath);
  const stem = fileStem(filePath);
  if (isNestedLocaleFile && stem && stem !== 'index' && key.startsWith(stem + '.')) return key.slice(stem.length + 1);
  return key;
}

function fileStem(filePath) {
  const fileName = String(filePath || '').replace(/\\/g, '/').split('/').at(-1) || '';
  return fileName.replace(/\.[^.]+$/, '');
}

export function buildHoverMarkdown(key, locales) {
  const names = Object.keys(locales).sort();
  if (names.length === 0) return '**' + key + '**\n\nNo locale JSON files found.';
  const lines = ['**' + key + '**', '', '| Locale | Text |', '|---|---|'];
  for (const name of names) {
    const value = locales[name].flat[key];
    lines.push('| ' + escapeMd(name) + ' | ' + escapeMd(value ?? 'Missing') + ' |');
  }
  return lines.join('\n');
}

function escapeMd(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function getDiagnostics(text, locales) {
  const localeEntries = Object.entries(locales);
  if (localeEntries.length === 0) return [];

  return extractI18nKeys(text).flatMap((item) => {
    const missingLocales = localeEntries
      .filter(([, locale]) => !Object.prototype.hasOwnProperty.call(locale.flat, item.key))
      .map(([name]) => name)
      .sort();

    const diagnostics = [];
    if (missingLocales.length > 0) {
      const missingInAllLocales = missingLocales.length === localeEntries.length;
      diagnostics.push({
        severity: missingInAllLocales ? 1 : 2,
        range: item.range,
        message: missingInAllLocales
          ? 'Missing i18n key: ' + item.key
          : 'Missing i18n key "' + item.key + '" in locales: ' + missingLocales.join(', '),
        source: 'i18n-lens',
        data: { key: item.key, missingLocales, missingInAllLocales },
      });
    }
    if (missingLocales.length !== localeEntries.length) {
      diagnostics.push(...getParamDiagnostics(item, localeEntries));
      const consistency = getLocaleParamConsistency(item.key, locales);
      if (!consistency.consistent) diagnostics.push(paramInconsistencyDiagnostic(item.key, item.range, consistency.perLocale));
    }
    return diagnostics;
  });
}

function getParamDiagnostics(item, localeEntries) {
  if (!Array.isArray(item.providedParams)) return [];
  const required = collectRequiredParams(item.key, localeEntries);
  const provided = new Set(item.providedParams);
  const missing = required.filter((n) => !provided.has(n));
  const unused = item.providedParams.filter((n) => !required.includes(n));
  const diagnostics = [];
  if (missing.length > 0)
    diagnostics.push({ severity: 2, range: item.range, message: 'Missing i18n params for "' + item.key + '": ' + missing.join(', '), source: 'i18n-lens', data: { key: item.key, missingParams: missing } });
  if (unused.length > 0)
    diagnostics.push({ severity: 2, range: item.range, message: 'Unused i18n params for "' + item.key + '": ' + unused.join(', '), source: 'i18n-lens', data: { key: item.key, unusedParams: unused } });
  return diagnostics;
}

function collectRequiredParams(key, localeEntries) {
  const params = new Set();
  for (const [, locale] of localeEntries) {
    const value = locale.flat[key];
    if (value === undefined) continue;
    for (const name of extractPlaceholders(value)) params.add(name);
  }
  return [...params].sort();
}

// Compare the interpolation placeholders a key uses across every locale that
// defines it. `consistent` is false when two locales that both define the key
// carry different param sets (a translation forgot or renamed a placeholder).
// Locales that do not define the key are ignored — that is a missing-key concern.
export function getLocaleParamConsistency(key, locales) {
  const perLocale = [];
  for (const [name, locale] of Object.entries(locales || {})) {
    const value = locale.flat?.[key];
    if (value === undefined) continue;
    perLocale.push({ name, params: extractPlaceholders(value) });
  }
  const union = [...new Set(perLocale.flatMap((entry) => entry.params))].sort();
  const consistent = perLocale.length < 2
    || perLocale.every((entry) => entry.params.length === union.length && union.every((param) => entry.params.includes(param)));
  return { consistent, perLocale, union };
}

// Warnings for keys defined in `locale`'s file whose params disagree with the
// same key in other locales, anchored at each key's position in the file text.
export function getLocaleParamDiagnostics(locale, filePath, text, locales) {
  if (!locale?.flat) return [];
  const isJson = /\.json$/i.test(filePath);
  const jsonRoot = isJson ? parseJsonStructure(text) || null : undefined;
  const diagnostics = [];
  for (const key of Object.keys(locale.flat)) {
    const consistency = getLocaleParamConsistency(key, locales);
    if (consistency.consistent) continue;
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, key);
    if (lookupKey === undefined) continue;
    const range = localeKeyRange(text, lookupKey, isJson, jsonRoot);
    if (range) diagnostics.push(paramInconsistencyDiagnostic(key, range, consistency.perLocale));
  }
  return diagnostics;
}

function paramInconsistencyDiagnostic(key, range, perLocale) {
  return {
    severity: 2,
    range,
    message: 'i18n params for "' + key + '" differ across locales — ' + formatPerLocaleParams(perLocale),
    source: 'i18n-lens',
    data: { key, paramInconsistency: perLocale },
  };
}

function formatPerLocaleParams(perLocale) {
  return perLocale
    .map((entry) => entry.name + ': ' + (entry.params.length ? entry.params.map((p) => '{' + p + '}').join(', ') : '(none)'))
    .join('; ');
}

export function getParamCodeActions(text, diagnostics = []) {
  const items = extractI18nKeys(text);
  return diagnostics.flatMap((diagnostic) => {
    const item = items.find((candidate) => candidate.key === diagnostic.data?.key && sameRange(candidate.range, diagnostic.range));

    const missingParams = diagnostic.data?.missingParams;
    if (Array.isArray(missingParams) && missingParams.length > 0) {
      if (!item?.paramsEdit) return [];
      const newText = item.paramsEdit.prefix + missingParams.join(', ') + (item.paramsEdit.suffix || '');
      return [{
        title: 'Add missing i18n params: ' + missingParams.join(', '),
        diagnostic,
        edit: { range: makeRange(text, item.paramsEdit.insertOffset, item.paramsEdit.insertOffset), newText },
      }];
    }

    const unusedParams = diagnostic.data?.unusedParams;
    if (Array.isArray(unusedParams) && unusedParams.length > 0) {
      if (!item?.paramsObject) return [];
      const kept = item.paramsObject.props.filter((prop) => !unusedParams.includes(prop.name));
      const rebuilt = kept.length ? '{ ' + kept.map((prop) => prop.text).join(', ') + ' }' : '{}';
      return [{
        title: 'Remove unused i18n params: ' + unusedParams.join(', '),
        diagnostic,
        edit: { range: makeRange(text, item.paramsObject.start, item.paramsObject.end), newText: rebuilt },
      }];
    }

    return [];
  });
}

/**
 * If [contentStart, contentEnd) is translatable text inside a static attribute
 * value or a bound attribute's whole string literal, returns safe rewrite bounds.
 */
function attributeLiteralContext(text, contentStart, contentEnd) {
  const before = text.slice(0, contentStart);
  const after = text.slice(contentEnd);
  let bound = /(?:^|[\s>])(?::|v-bind:)([\w-]+)\s*=\s*(["'])\s*(['"]?)\s*$/.exec(before);
  let plain = !bound && /(?:^|[\s>])([\w-]+)\s*=\s*(["'])\s*$/.exec(before);
  const unquoted = !bound && !plain
    && (/(?:^|[\s>])(?::|v-bind:)([\w-]+)\s*=\s*$/.exec(before)
      || /(?:^|[\s>])([\w-]+)\s*=\s*$/.exec(before));
  if (unquoted && !/^[^\s"'=<>`]/.test(after)) {
    const attrStart = contentStart - unquoted[0].length + unquoted[0].search(/\S/);
    return { name: unquoted[1], openQuote: '"', innerQuote: '', attrStart, attrEnd: contentEnd };
  }
  const m = bound || plain;
  if (!m) return null;
  const name = m[1];
  const openQuote = bound ? bound[2] : plain[2];
  const innerQuote = bound?.[3] || '';
  const closeRe = innerQuote
    ? new RegExp(`^\\s*${escapeRegExp(innerQuote)}\\s*${escapeRegExp(openQuote)}`)
    : new RegExp(`^\\s*${escapeRegExp(openQuote)}`);
  const closeMatch = closeRe.exec(after);
  if (!closeMatch) return null;
  const attrStart = contentStart - m[0].length + m[0].search(/\S/);
  const attrEnd = contentEnd + closeMatch[0].length;
  return { name, openQuote, innerQuote, attrStart, attrEnd };
}

/**
 * "Extract to i18n key" for raw-text diagnostics (or raw text inside a selected
 * range). Key = `<prefix>.<slug>` where the prefix comes from deriveKeyPrefix
 * (nearest ancestor keys > file keys > file stem); always a new key (identical
 * text elsewhere is not reused; it may need a different translation).
 */
export function getExtractCodeActions(text, language, filePath, range, diagnostics = [], defaultFlat = {}) {
  let targets = diagnostics.filter((d) => d.code === 'raw-text');
  const start = range ? positionToOffset(text, range.start) : 0;
  const end = range ? positionToOffset(text, range.end) : 0;
  if (!targets.length && range) {
    // Selection: every loose candidate inside it. Cursor: the candidate under it.
    targets = getRawTextDiagnostics(text, language, true, true).filter((d) => {
      const s = positionToOffset(text, d.range.start);
      const e = positionToOffset(text, d.range.end);
      return end > start ? s >= start && e <= end : s <= start && start <= e;
    });
  }
  const calls = extractI18nKeys(text, { includeStaticAttrCalls: true });
  return targets.flatMap((diagnostic) => {
    const s = positionToOffset(text, diagnostic.range.start);
    const e = positionToOffset(text, diagnostic.range.end);
    if (calls.some((c) => c.call && c.call.start <= s && e <= c.call.end)) return [];
    const value = text.slice(s, e).replace(/\s+/g, ' ');
    // v1: no entities or interpolation-like content; their decoded value is ambiguous.
    if (!value || /[&<>{}]/.test(value)) return [];
    const { prefix, source: keySource } = deriveKeyPrefix(text, language, filePath, s, e, defaultFlat);
    const key = uniqueKey(prefix + '.' + slugify(value), defaultFlat);
    if (!key) return [];
    const attr = attributeLiteralContext(text, s, e);
    let edit;
    if (attr) {
      edit = { range: makeRange(text, attr.attrStart, attr.attrEnd), newText: `:${attr.name}="$t('${key}')"` };
    } else {
      edit = { range: makeRange(text, s, e), newText: `{{ $t('${key}') }}` };
    }
    return [{ title: `Extract to i18n key "${key}"`, diagnostic, key, keySource, value, edit }];
  });
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Lightweight tag-stack scan: returns closed elements { tag, start, end, attrs }. */
function scanElements(text, opaque = computeOpaqueRanges(text).ranges) {
  const elements = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    if (isOpaque(opaque, m.index)) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const idx = stack.map((x) => x.tag).lastIndexOf(tag);
      if (idx < 0) continue;
      while (stack.length > idx) {
        const el = stack.pop();
        el.end = stack.length === idx ? re.lastIndex : m.index;
        elements.push(el);
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[4] || VOID_ELEMENTS.has(tag)) continue;
      const el = { tag, start: m.index, end: text.length, attrs: m[3], openEnd: re.lastIndex };
      if (tag === 'script' || tag === 'style') {
        const close = text.toLowerCase().indexOf('</' + tag, re.lastIndex);
        const stop = close < 0 ? text.length : text.indexOf('>', close) + 1 || text.length;
        el.end = stop;
        elements.push(el);
        re.lastIndex = stop;
        continue;
      }
      stack.push(el);
    }
  }
  while (stack.length) elements.push(stack.pop());
  return elements;
}

function markupFrame(text, offset) {
  const opaque = computeOpaqueRanges(text).ranges;
  const el = scanElements(text, opaque)
    .filter((e) => e.start <= offset && offset < e.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  if (el) {
    if (el.tag === 'script' || el.tag === 'style') return 'script';
    return offset < el.openEnd ? 'openTag' : 'text';
  }
  const before = text.slice(0, offset);
  const lastLt = before.lastIndexOf('<');
  const lastGt = before.lastIndexOf('>');
  if (lastLt > lastGt && /^[A-Za-z]/.test(before.slice(lastLt + 1)) && !isOpaque(opaque, lastLt)) return 'openTag';
  return 'code';
}

function jsxAttributeContext(text, start, end) {
  if (markupFrame(text, start) !== 'openTag') return null;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const m = /(?:^|[\s<])([\w-]+)\s*=\s*\{\s*$/.exec(before);
  const close = /^\s*\}/.exec(after);
  if (!m || !close) return null;
  const attrStart = start - m[0].length + m[0].search(/\S/);
  const attrEnd = end + close[0].length;
  return { name: m[1], attrStart, attrEnd };
}

function commonKeyPrefix(keys) {
  let common;
  for (const key of keys) {
    const parts = key.split('.').slice(0, -1);
    if (common === undefined) common = parts;
    else {
      let i = 0;
      while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
      common = common.slice(0, i);
    }
  }
  return common && common.length ? common.join('.') : '';
}

const normalizeSegment = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Descend into an existing child group whose name matches an ancestor's id/data-anchor. */
function descendByAnchor(prefix, ancestors, flat) {
  const children = new Set();
  for (const k of Object.keys(flat)) {
    if (!k.startsWith(prefix + '.')) continue;
    const rest = k.slice(prefix.length + 1).split('.');
    if (rest.length > 1) children.add(rest[0]);
  }
  for (const el of ancestors) {
    const a = /(?:^|\s)(?:id|data-anchor)\s*=\s*(["'])([^"']+)\1/.exec(el.attrs);
    if (!a) continue;
    const want = normalizeSegment(a[2]);
    const hit = [...children].find((c) => normalizeSegment(c) === want);
    if (hit) return prefix + '.' + hit;
  }
  return prefix;
}

/**
 * Prefix for a new extracted key: common prefix of keys in the nearest ancestor
 * element that has any, else of all keys in the file, else the file stem.
 */
function deriveKeyPrefix(text, language, filePath, s, e, flat) {
  const keys = extractI18nKeys(text);
  if (keys.length && (language === 'vue' || language === 'html')) {
    const ancestors = scanElements(text)
      .filter((el) => el.start <= s && el.end >= e && el.tag !== 'template')
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));
    for (let i = 0; i < ancestors.length; i++) {
      const el = ancestors[i];
      const inside = keys.filter((k) => k.startOffset >= el.start && k.endOffset <= el.end).map((k) => k.key);
      if (!inside.length) continue;
      const prefix = commonKeyPrefix(inside);
      if (prefix) return { prefix: descendByAnchor(prefix, ancestors.slice(0, i + 1), flat), source: 'ancestor' };
      break;
    }
  }
  const filePrefix = commonKeyPrefix(keys.map((k) => k.key));
  if (filePrefix) return { prefix: filePrefix, source: 'file' };
  return { prefix: fileStem(filePath), source: 'filename' };
}

function slugify(value) {
  const words = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length) return words.slice(0, 4).join('_');
  // Non-Latin text: deterministic FNV-1a hash instead of a transliteration.
  let hash = 0x811c9dc5;
  for (const ch of value) hash = Math.imul(hash ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return 'text_' + hash.toString(16);
}

function uniqueKey(base, flat) {
  const leaves = new Set(Object.keys(flat));
  const branches = new Set();
  for (const key of leaves) {
    for (let dot = key.indexOf('.'); dot !== -1; dot = key.indexOf('.', dot + 1)) branches.add(key.slice(0, dot));
  }
  const hasLeafAncestor = (key) => {
    for (let dot = key.indexOf('.'); dot !== -1; dot = key.indexOf('.', dot + 1)) {
      if (leaves.has(key.slice(0, dot))) return true;
    }
    return false;
  };
  const taken = (key) => leaves.has(key) || branches.has(key) || hasLeafAncestor(key);

  function allocate(candidate) {
    if (!candidate) return undefined;
    if (!taken(candidate)) return candidate;
    // Suffixing the last segment cannot escape a leaf ancestor (`Home` vs
    // `Home.hello_world_2`), so give up this candidate rather than loop.
    if (hasLeafAncestor(candidate)) return undefined;
    for (let n = 2; n <= 10000; n++) {
      const key = candidate + '_' + n;
      if (!taken(key)) return key;
    }
    return undefined;
  }

  // Prefixes that are already string leaves cannot host children. Drop those
  // segments and keep the rest under the longest still-object (or empty)
  // prefix: `hello.hello_world` with leaf `hello` → `hello_world`; `a.b.c.d`
  // with leaf `a.b` → `a.c.d`. Exact / descendant collisions still suffix
  // the last segment (`d_2`, `d_3`, …).
  const parts = base.split('.');
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    const next = [...kept, parts[i]].join('.');
    if (i < parts.length - 1 && Object.hasOwn(flat, next)) continue;
    kept.push(parts[i]);
  }
  return allocate(kept.join('.'));
}

/**
 * "Inline as <locale>": replace a param-less t('key') call with locale text.
 */
export function getInlineCodeActions(text, range, locales = {}) {
  const offset = positionToOffset(text, range.start);
  const endOffset = positionToOffset(text, range.end || range.start);
  // Cursor (or selection) must sit inside the call; a whole-file range offers nothing.
  const item = extractI18nKeys(text, { includeStaticAttrCalls: true }).find((c) => c.call && offset >= c.call.start && endOffset <= c.call.end);
  if (!item || item.call.argCount !== 1) return [];
  const { start, end, quote } = item.call;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const interp = /\{\{\s*$/.exec(before);
  const interpEnd = /^\s*\}\}/.exec(after);
  const attr = attributeLiteralContext(text, start, end);
  if (!attr) {
    const openAttr = /(?:^|[\s>])(?:(?::|v-bind:)?[\w-]+)\s*=\s*(["'])(?:(?!\1)[\s\S])*$/.exec(before);
    if (openAttr && after.includes(openAttr[1])) return [];
  }
  const jsxAttr = !attr && jsxAttributeContext(text, start, end);
  const frame = markupFrame(text, start);
  const jsxOpen = /\{\s*$/.exec(before);
  const jsxClose = /^\s*\}/.exec(after);
  const jsxChild = !attr && !jsxAttr && frame === 'text' && jsxOpen && jsxClose;
  const htmlText = !attr && !jsxAttr && !jsxChild && frame === 'text' && !/\{[^{]*$/.test(before);
  return Object.entries(locales).flatMap(([name, locale]) => {
    const value = locale?.flat?.[item.key];
    if (typeof value !== 'string') return [];
    let edit;
    if (interp && interpEnd) {
      // `{++counter}` or `{{ test }}` must stay a JS string inside the
      // mustache; stripping `{{ }}` would let Vue re-parse the braces.
      if (/[{}]/.test(value)) {
        edit = { range: makeRange(text, start, end), newText: escapeJsString(value, quote) };
      } else {
        edit = { range: makeRange(text, start - interp[0].length, end + interpEnd[0].length), newText: escapeHtml(value) };
      }
    } else if (attr) {
      const vueBound = text[attr.attrStart] === ':' || text.startsWith('v-bind:', attr.attrStart);
      let boundLiteral;
      if (attr.innerQuote || (vueBound && /[{}]/.test(value))) {
        const jsQuote = attr.innerQuote || (attr.openQuote === '"' ? "'" : '"');
        // The JS literal is nested in HTML: JS escapes alone cannot protect the
        // outer attribute quote or preserve literal entity text such as &quot;.
        const expression = escapeHtmlAttribute(escapeJsString(value, jsQuote), attr.openQuote);
        boundLiteral = `:${attr.name}=${attr.openQuote}${expression}${attr.openQuote}`;
      } else {
        boundLiteral = `${attr.name}="${escapeHtml(value)}"`;
      }
      edit = { range: makeRange(text, attr.attrStart, attr.attrEnd), newText: boundLiteral };
    } else if (jsxAttr) {
      edit = { range: makeRange(text, jsxAttr.attrStart, jsxAttr.attrEnd), newText: `${jsxAttr.name}="${escapeHtml(value)}"` };
    } else if (jsxChild) {
      // `{++counter}` or `Hello {name}` must stay a string, not a JSX expression.
      if (/[{}]/.test(value)) {
        edit = { range: makeRange(text, start, end), newText: escapeJsString(value, quote) };
      } else {
        edit = { range: makeRange(text, start - jsxOpen[0].length, end + jsxClose[0].length), newText: escapeHtml(value) };
      }
    } else if (htmlText) {
      edit = { range: makeRange(text, start, end), newText: escapeHtml(value) };
    } else {
      edit = { range: makeRange(text, start, end), newText: escapeJsString(value, quote) };
    }
    return [{ title: `Inline i18n key "${item.key}" as ${name}`, edit }];
  });
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtmlAttribute(value, quote) {
  const escaped = escapeHtml(value);
  return quote === "'" ? escaped.replace(/'/g, '&#39;') : escaped;
}

function escapeJsString(value, quote) {
  let escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(escapeRegExp(quote), 'g'), '\\' + quote)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  if (quote === '`') escaped = escaped.replace(/\$\{/g, '\\${');
  // Break </script> / </style> so a generated literal cannot close an HTML
  // <script> / <style> element. `\/` is still `/` in JS string values.
  escaped = escaped.replace(/<\/(script|style)/gi, '<\\/$1');
  return quote + escaped + quote;
}

function sameRange(a, b) {
  return a?.start?.line === b?.start?.line
    && a?.start?.character === b?.start?.character
    && a?.end?.line === b?.end?.line
    && a?.end?.character === b?.end?.character;
}

export function extractPlaceholders(value) {
  const params = new Set();
  // ICU-style: {name, plural, ...} — extract top-level name, skip nested content
  let text = String(value);
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    const head = text.slice(open).match(/^\{\s*([A-Za-z_$][\w$]*)\s*,/);
    if (head) {
      params.add(head[1]);
      let depth = 0, i = open;
      while (i < text.length) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      text = text.slice(0, open) + ' '.repeat(i - open + 1) + text.slice(i + 1);
      cursor = open;
      continue;
    }
    cursor = open + 1;
  }
  const re = /\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
  let m;
  while ((m = re.exec(text))) params.add(m[1]);
  return [...params].sort();
}

export function resolvePreferredLocale(locales, defaultLocale) {
  if (!locales || Object.keys(locales).length === 0) return undefined;
  if (locales[defaultLocale]) return locales[defaultLocale];

  const requested = normalizeLocaleName(defaultLocale);
  const entries = Object.entries(locales);
  const exactNormalized = entries.find(([name]) => normalizeLocaleName(name) === requested);
  if (exactNormalized) return exactNormalized[1];

  const requestedLanguage = requested.split('-')[0];
  const languageMatch = entries.find(([name]) => {
    const candidate = normalizeLocaleName(name);
    const candidateLanguage = candidate.split('-')[0];
    return candidateLanguage && requestedLanguage && candidateLanguage === requestedLanguage;
  });
  return languageMatch?.[1] || entries[0][1];
}

function normalizeLocaleName(name) {
  return String(name || '').trim().replace(/_/g, '-').toLowerCase();
}

export function getCompletions(prefix, locales, defaultLocale) {
  const keys = new Set();
  for (const locale of Object.values(locales)) for (const key of Object.keys(locale.flat)) keys.add(key);
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  return [...keys]
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => ({ label: key, kind: 12, detail: preferred?.flat[key] || undefined, insertText: key }));
}


export function getDefinitionLocaleOrder(locales, defaultLocale) {
  const localeList = Object.values(locales || {});
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  if (!preferred) return localeList;
  return [preferred, ...localeList.filter((locale) => locale !== preferred)];
}

// Every locale that defines the key, with the default locale first, so
// Go to Definition can return one LSP Location per language file.
export function collectLocaleKeyTargets(locales, key, localeTexts = {}, defaultLocale) {
  return getDefinitionLocaleOrder(locales, defaultLocale)
    .map((locale) => findLocaleKeyTarget(locale, key, localeTexts))
    .filter((target) => target?.position);
}

// Inverse of findLocaleKeyTarget: given a caret position inside a locale file,
// return the full flattened key it points at (so Find References can jump back
// to the code). Reuses the same key->location logic as Go to Definition to stay
// consistent; precise for JSON, best-effort (line-based) for TS/JS locale modules.
export function localeKeyAtPosition(locale, filePath, text, position) {
  if (!locale || !locale.flat || !text || !position) return undefined;
  const isJson = /\.json$/i.test(filePath);
  const jsonRoot = isJson ? parseJsonStructure(text) || null : undefined;
  let lineFallback;
  let lineFallbackCount = 0;
  for (const fullKey of Object.keys(locale.flat)) {
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, fullKey);
    if (lookupKey === undefined) continue;
    const range = localeKeyRange(text, lookupKey, isJson, jsonRoot);
    if (!range || range.start.line !== position.line) continue;
    if (comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) < 0) return fullKey;
    lineFallback = fullKey;
    lineFallbackCount++;
  }
  return !isJson && lineFallbackCount === 1 ? lineFallback : undefined;
}

export function getCompletionPrefix(text, position) {
  const before = text.slice(0, positionToOffset(text, position));
  const { ranges: opaque } = computeOpaqueRanges(before);
  const patterns = [
    /(?:\x24tc?|\btc?|\bi18n\.tc?)\s*\(\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\bformatMessage\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\b(?:keypath|i18nKey)\s*=\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*"'([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*'\x22([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*"\s*\{\s*path\s*:\s*['"]([A-Za-z0-9_.:-]*)$/,
  ];
  for (const re of patterns) {
    const match = before.match(re);
    if (!match || isOpaque(opaque, match.index)) continue;
    if (/[\w$:@#-]/.test(before[match.index - 1] || '')) continue;
    return match[1];
  }
  return undefined;
}

export function findJsonKeyLocation(jsonText, key) {
  return localeKeyRange(jsonText, key, true)?.start;
}

function localeKeyRange(text, key, isJson, jsonRoot = isJson ? parseJsonStructure(text) : undefined) {
  if (isJson) {
    const property = findJsonProperty(jsonRoot, key.split('.'));
    return property ? makeRange(text, property.start, property.end) : undefined;
  }
  const start = findLocaleKeyLocation(text, key);
  if (!start) return undefined;
  const offset = positionToOffset(text, start);
  const token = text.slice(offset).match(/^(?:'[^']*'|"[^"]*"|[\w$-]+)/);
  return token ? makeRange(text, offset, offset + token[0].length) : undefined;
}

// JSON.parse validates the grammar; this walk retains property-token and value
// boundaries for edits. Maps avoid prototype keys and duplicate keys are refused.
function parseJsonStructure(text) {
  try { JSON.parse(text); } catch { return undefined; }
  let offset = 0;
  let duplicate = false;
  const whitespace = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset++; };
  function stringEnd() {
    offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') break;
    }
  }
  function value() {
    whitespace();
    const start = offset;
    const properties = text[offset] === '{' ? new Map() : undefined;
    if (properties) {
      offset++;
      whitespace();
      while (text[offset] !== '}') {
        const keyStart = offset;
        stringEnd();
        const keyEnd = offset;
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        whitespace();
        offset++; // colon
        const child = value();
        if (properties.has(key)) duplicate = true;
        properties.set(key, { start: keyStart, end: keyEnd, value: child });
        whitespace();
        if (text[offset] !== ',') break;
        offset++;
        whitespace();
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++;
      whitespace();
      while (text[offset] !== ']') {
        value();
        whitespace();
        if (text[offset] !== ',') break;
        offset++;
      }
      offset++;
    } else if (text[offset] === '"') {
      stringEnd();
    } else {
      while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    }
    return { start, end: offset, properties };
  }
  const root = value();
  return duplicate ? undefined : root;
}

function findJsonProperty(node, parts) {
  if (!node?.properties) return undefined;
  let found;
  for (let count = 1; count <= parts.length; count++) {
    const property = node.properties.get(parts.slice(0, count).join('.'));
    if (!property) continue;
    const candidate = count === parts.length ? property : findJsonProperty(property.value, parts.slice(count));
    if (!candidate) continue;
    if (found) return undefined; // dotted and nested representations collide
    found = candidate;
  }
  return found;
}

// Insert only into an unambiguous object path. Existing scalar/array prefixes,
// duplicate properties and existing values are never overwritten.
export function insertNestedJsonKey(jsonText, key, value = '') {
  let node = parseJsonStructure(jsonText);
  let parts = key.split('.');
  if (!node?.properties || parts.some((part) => !part)) return undefined;
  let depth = 0;
  while (true) {
    const matches = [];
    for (let count = 1; count <= parts.length; count++) {
      const property = node.properties.get(parts.slice(0, count).join('.'));
      if (property) matches.push({ count, property });
    }
    if (!matches.length) break;
    if (matches.length !== 1) return undefined;
    const { count, property } = matches[0];
    if (count === parts.length || !property.value.properties) return undefined;
    parts = parts.slice(count);
    node = property.value;
    depth++;
  }
  const eol = jsonText.includes('\r\n') ? '\r\n' : '\n';
  const unit = detectIndentUnit(jsonText);
  const firstProperty = node.properties.values().next().value;
  const lineStart = firstProperty ? jsonText.lastIndexOf('\n', firstProperty.start) + 1 : -1;
  const existingIndent = firstProperty ? jsonText.slice(lineStart, firstProperty.start) : '';
  const indent = firstProperty && /^[ \t]+$/.test(existingIndent) ? existingIndent : unit.repeat(depth + 1);
  const snippet = buildNestedProperty(parts, value, indent, unit, eol);
  let contentEnd = node.end - 1;
  while (contentEnd > node.start + 1 && /\s/.test(jsonText[contentEnd - 1])) contentEnd--;
  if (!node.properties.size) {
    return jsonText.slice(0, node.start + 1) + eol + snippet + eol + indent.slice(0, -unit.length) + jsonText.slice(node.end - 1);
  }
  return jsonText.slice(0, contentEnd) + ',' + eol + snippet + jsonText.slice(contentEnd);
}

function detectIndentUnit(jsonText) {
  const match = jsonText.match(/\n([ \t]+)\S/);
  return match ? match[1] : '  ';
}

function buildNestedProperty(parts, value, indent, unit, eol) {
  const keyStr = JSON.stringify(parts[0]);
  if (parts.length === 1) return indent + keyStr + ': ' + JSON.stringify(value);
  return indent + keyStr + ': {' + eol + buildNestedProperty(parts.slice(1), value, indent + unit, unit, eol) + eol + indent + '}';
}


// File and directory namespaces are applied by the loader, not the parser.
export function parseTsLocaleModule(text, fileName = 'index.ts') {
  const result = {};
  const stem = fileName.replace(/\.[cm]?[tj]sx?$/i, '');
  const exportObject = extractObjectAfter(text, /export\s+default\s*/g);
  if (exportObject) {
    Object.assign(result, flattenJsObjectLiteral(exportObject));
  }

  if (stem === 'index') {
    const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    let match;
    while ((match = constRe.exec(text))) {
      const objectStart = text.indexOf('{', match.index);
      const objectText = readBalanced(text, objectStart);
      if (objectText) Object.assign(result, flattenJsObjectLiteral(objectText, match[1]));
    }
  }
  return result;
}

function extractObjectAfter(text, re) {
  const match = re.exec(text);
  if (!match) return undefined;
  const start = text.indexOf('{', match.index + match[0].length);
  if (start === -1) return undefined;
  return readBalanced(text, start);
}

function readBalanced(text, start) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function flattenJsObjectLiteral(objectText, prefix = '', out = {}) {
  const body = objectText.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,;]/.test(body[i])) i++;
    if (body.startsWith('//', i)) { const end = body.indexOf('\n', i); i = end === -1 ? body.length : end + 1; continue; }
    if (body.startsWith('/*', i)) { const end = body.indexOf('*/', i + 2); i = end === -1 ? body.length : end + 2; continue; }
    const keyMatch = body.slice(i).match(/^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$-]*))\s*:/);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1] || keyMatch[2];
    i += keyMatch[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;
    const fullKey = prefix ? prefix + '.' + key : key;
    if (body[i] === '{') {
      const nested = readBalanced(body, i);
      if (!nested) break;
      flattenJsObjectLiteral(nested, fullKey, out);
      i += nested.length;
      continue;
    }
    const value = readJsValue(body, i);
    if (value) {
      if (value.kind === 'string') out[fullKey] = value.value;
      i = value.end;
    } else i++;
  }
  return out;
}

function readJsValue(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let value = '';
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { value += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === quote) return { kind: 'string', value, end: i + 1 };
    value += ch;
  }
  return undefined;
}

export function findLocaleKeyLocation(text, key) {
  const parts = key.split('.');
  const last = parts[parts.length - 1];
  const re = new RegExp('(?:["\\\']' + escapeRegExp(last) + '["\\\']|' + escapeRegExp(last) + ')\\s*:', 'g');
  const match = re.exec(text);
  return match ? offsetToPosition(text, match.index) : undefined;
}


export function getInlayHints(text, range, locales, defaultLocale, options = {}) {
  if (options.enabled === false) return [];
  const maxLength = options.maxLength ?? DEFAULT_CONFIG.inlayHints.maxLength;
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  if (!preferred) return [];

  return extractI18nKeys(text)
    .filter((item) => isPositionInRange(item.range.start, range))
    .map((item) => {
      const value = preferred.flat[item.key];
      if (value === undefined) return undefined;
      return {
        position: inlayPositionAfterKeyLiteral(text, item),
        label: truncateInlayText(value, maxLength),
        paddingLeft: true,
        tooltip: value,
      };
    })
    .filter(Boolean);
}

function inlayPositionAfterKeyLiteral(text, item) {
  const next = text[item.endOffset];
  const offset = (next === '"' || next === "'") ? item.endOffset + 1 : item.endOffset;
  return offsetToPosition(text, offset);
}

function isPositionInRange(position, range) {
  if (!range) return true;
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function truncateInlayText(value, maxLength) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)) + '…';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^()|[\]\{}]/g, '\\$&');
}
