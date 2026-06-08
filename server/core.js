export const DEFAULT_CONFIG = Object.freeze({
  defaultLocale: 'zh-CN',
  localeDirs: Object.freeze(['src/locales', 'src/i18n', 'locales', 'i18n']),
  inlayHints: Object.freeze({ enabled: true, maxLength: 24 }),
  packages: Object.freeze([]),
});

export function normalizeI18nLensConfig(raw = {}) {
  const base = normalizeProjectConfig(raw, DEFAULT_CONFIG);
  const packages = Array.isArray(raw.packages)
    ? raw.packages
      .map((pkg) => normalizePackageConfig(pkg, base))
      .filter(Boolean)
    : [];

  return { ...base, packages };
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

export function extractI18nKeys(text) {
  const found = [];
  const patterns = [
    /(?:\x24t|\bt|\bi18n\.t)\(\s*(['\"])([A-Za-z0-9_.:-]+)\1/g,
    /\bv-t\s*=\s*\"'([A-Za-z0-9_.:-]+)'\"/g,
    /\bv-t\s*=\s*\"\s*\{\s*path\s*:\s*(['\"])([A-Za-z0-9_.:-]+)\1/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const key = match[2] || match[1];
      const keyOffsetInMatch = match[0].indexOf(key);
      const start = match.index + keyOffsetInMatch;
      const end = start + key.length;
      found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end });
    }
  }
  found.sort((a, b) => a.startOffset - b.startOffset);
  return found;
}

export function keyAtPosition(text, position) {
  const offset = positionToOffset(text, position);
  return extractI18nKeys(text).find((item) => item.startOffset <= offset && offset <= item.endOffset);
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

  return extractI18nKeys(text)
    .map((item) => {
      const missingLocales = localeEntries
        .filter(([, locale]) => !Object.prototype.hasOwnProperty.call(locale.flat, item.key))
        .map(([name]) => name)
        .sort();

      if (missingLocales.length === 0) return undefined;
      const missingInAllLocales = missingLocales.length === localeEntries.length;
      return {
        severity: missingInAllLocales ? 1 : 2,
        range: item.range,
        message: missingInAllLocales
          ? 'Missing i18n key: ' + item.key
          : 'Missing i18n key "' + item.key + '" in locales: ' + missingLocales.join(', '),
        source: 'i18n-lens',
        data: { key: item.key, missingLocales, missingInAllLocales },
      };
    })
    .filter(Boolean);
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

export function getCompletionPrefix(text, position) {
  const offset = positionToOffset(text, position);
  const before = text.slice(0, offset);
  const match = before.match(/(?:\x24t|\bt|\bi18n\.t)\(\s*['\"]([A-Za-z0-9_.:-]*)$/) || before.match(/v-t\s*=\s*\"'([A-Za-z0-9_.:-]*)$/);
  return match ? match[1] : '';
}

export function findJsonKeyLocation(jsonText, key) {
  const parts = key.split('.');
  let cursor = 0;
  for (const part of parts) {
    const re = new RegExp('"' + escapeRegExp(part) + '"\\s*:', 'g');
    re.lastIndex = cursor;
    const match = re.exec(jsonText);
    if (!match) return undefined;
    cursor = match.index + match[0].length;
    if (part === parts[parts.length - 1]) return offsetToPosition(jsonText, match.index);
  }
  return undefined;
}


export function parseTsLocaleModule(text, fileName = 'index.ts') {
  const result = {};
  const stem = fileName.replace(/\.[cm]?[tj]sx?$/i, '');
  const exportObject = extractObjectAfter(text, /export\s+default\s*/g);
  if (exportObject) {
    Object.assign(result, flattenJsObjectLiteral(exportObject, stem === 'index' ? '' : stem));
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
