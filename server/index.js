#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, MarkupKind, CodeActionKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  flattenLocale,
  buildHoverMarkdown,
  getDiagnostics,
  getLocaleParamDiagnostics,
  getParamCodeActions,
  insertNestedJsonKey,
  getCompletions,
  getCompletionPrefix,
  keyAtPosition,
  parseTsLocaleModule,
  collectLocaleKeyTargets,
  localeKeyAtPosition,
  findCodeKeyRanges,
  getInlayHints,
  normalizeI18nLensConfig,
  mergeI18nLensConfig,
  resolveConfigPath,
  CONFIG_RELATIVE_PATH,
  didWatchedFileChange,
  collectLocaleWatchPaths,
  resolveProjectContext,
} from './core.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspaceRoot = process.cwd();
let zedSettingsConfig = {};
let config = normalizeI18nLensConfig();
let watchedConfigPath;
const watchedLocalePaths = new Set();
let reloadTimer;
let configMtimeMs;
let localeCacheByContext = new Map();
const configWatchIntervalMs = 1000;
const localeWatchIntervalMs = 1000;
const reloadDebounceMs = 100;

connection.onInitialize((params) => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri ? fileURLToPath(params.workspaceFolders[0].uri) : (params.rootUri ? fileURLToPath(params.rootUri) : process.cwd());
  zedSettingsConfig = normalizeIncomingSettings(params.initializationOptions);
  loadConfig();
  watchConfigFile();
  return { capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental, hoverProvider: true, completionProvider: { triggerCharacters: ['.', '"', "'"] }, definitionProvider: true, referencesProvider: true, inlayHintProvider: true, codeActionProvider: true } };
});

connection.onInitialized(() => {
  // After (re)start the editor does not always re-request inlay hints for
  // already-open documents, so features only appeared after the first edit.
  // Proactively reload config/locales and ask the editor to refresh.
  scheduleProjectReload();
});

documents.onDidOpen((event) => {
  validate(event.document);
  // A freshly started server may receive the inlay-hint request before the
  // locale cache is ready; prompt the editor to re-request once it is.
  refreshInlayHints();
});
documents.onDidChangeContent((event) => validate(event.document));
documents.onDidSave(() => scheduleProjectReload());

connection.onDidChangeConfiguration((params) => {
  zedSettingsConfig = normalizeIncomingSettings(params.settings);
  scheduleProjectReload();
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  return {
    contents: { kind: MarkupKind.Markdown, value: buildHoverMarkdown(item.key, locales) },
    range: item.range,
  };
});

connection.onCompletion((params) => {
  if (!isSourceFile(params.textDocument.uri)) return [];
  const doc = documents.get(params.textDocument.uri);
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  const prefix = doc ? getCompletionPrefix(doc.getText(), params.position) : '';
  return getCompletions(prefix, locales, context.config.defaultLocale);
});

connection.languages.inlayHint.on((params) => {
  if (!isSourceFile(params.textDocument.uri)) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  return getInlayHints(doc.getText(), params.range, locales, context.config.defaultLocale, context.config.inlayHints);
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  const context = getProjectContext(params.textDocument.uri);
  const { locales, localeTexts } = loadLocalesForContext(context);
  const keyTokenLength = item.key.split('.').at(-1).length + 2;
  const locations = collectLocaleKeyTargets(locales, item.key, localeTexts, context.config.defaultLocale)
    .map(({ filePath, position }) => ({
      uri: pathToFileURL(filePath).toString(),
      range: { start: position, end: { line: position.line, character: position.character + keyTokenLength } },
    }));
  return locations.length ? locations : null;
});

connection.onReferences((params) => {
  const uri = params.textDocument.uri;
  const context = getProjectContext(uri);
  const key = resolveKeyAtPosition(uri, params.position, context);
  if (!key) return null;

  const locations = collectCodeReferences(context, key);
  if (params.context?.includeDeclaration) {
    const { locales, localeTexts } = loadLocalesForContext(context);
    const keyTokenLength = key.split('.').at(-1).length + 2;
    for (const { filePath, position } of collectLocaleKeyTargets(locales, key, localeTexts, context.config.defaultLocale)) {
      locations.push({
        uri: pathToFileURL(filePath).toString(),
        range: { start: position, end: { line: position.line, character: position.character + keyTokenLength } },
      });
    }
  }
  return locations.length ? locations : null;
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  const diagnostics = params.context.diagnostics || [];
  const actions = [];
  if (doc) {
    for (const action of getParamCodeActions(doc.getText(), diagnostics)) {
      actions.push({
        title: action.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [action.diagnostic],
        edit: { changes: { [params.textDocument.uri]: [action.edit] } },
      });
    }
  }
  actions.push(...getCreateKeyActions(diagnostics, getProjectContext(params.textDocument.uri)));
  return actions;
});

// Quick fix for a "missing i18n key" diagnostic: create the key (empty value) in
// every locale file that lacks it, as a cross-file workspace edit. Only single
// flat JSON locale files are supported; nested/TS locales are skipped.
function getCreateKeyActions(diagnostics, context) {
  const { locales, localeTexts } = loadLocalesForContext(context);
  const actions = [];
  for (const diagnostic of diagnostics) {
    const key = diagnostic.data?.key;
    const missingLocales = diagnostic.data?.missingLocales;
    if (!key || !Array.isArray(missingLocales) || missingLocales.length === 0) continue;

    const changes = {};
    for (const name of missingLocales) {
      const filePath = flatLocaleFile(locales[name]);
      if (!filePath) continue;
      const text = localeTexts[filePath] ?? readFileSafe(filePath);
      if (text === undefined) continue;
      const newText = insertNestedJsonKey(text, key, '');
      if (newText === undefined) continue;
      changes[pathToFileURL(filePath).toString()] = [fullDocumentEdit(text, newText)];
    }

    const fileCount = Object.keys(changes).length;
    if (fileCount === 0) continue;
    actions.push({
      title: `Create i18n key "${key}" in ${fileCount} locale file(s)`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: { changes },
    });
  }
  return actions;
}

// A locale backed by a single flat .json file (not a nested directory locale).
function flatLocaleFile(locale) {
  if (!locale || !/\.json$/i.test(locale.path || '')) return undefined;
  const files = locale.files?.length ? locale.files : [locale.path];
  return files.length === 1 && files[0] === locale.path ? locale.path : undefined;
}

function fullDocumentEdit(oldText, newText) {
  const lines = oldText.split('\n');
  const endLine = lines.length - 1;
  return { range: { start: { line: 0, character: 0 }, end: { line: endLine, character: lines[endLine].length } }, newText };
}

function getProjectContext(uri) {
  loadConfigIfChanged();
  const filePath = uri ? fileURLToPath(uri) : workspaceRoot;
  return resolveProjectContext(filePath, workspaceRoot, config);
}

function watchConfigFile() {
  const configPath = resolveConfigPath(workspaceRoot);
  if (watchedConfigPath === configPath) return;
  if (watchedConfigPath) fs.unwatchFile(watchedConfigPath);
  watchedConfigPath = configPath;
  fs.watchFile(configPath, { interval: configWatchIntervalMs }, (current, previous) => {
    if (didWatchedFileChange(previous, current)) scheduleProjectReload();
  });
}

function watchLocalePaths() {
  const nextPaths = new Set();
  const contexts = getAllConfiguredContexts();
  for (const context of contexts) {
    const configuredDirs = context.config.localeDirs
      .map((dir) => path.join(context.root, dir))
      .filter((dir) => fs.existsSync(dir));
    const loaded = loadLocalesForContext(context);
    for (const watchPath of collectLocaleWatchPaths(loaded.locales, configuredDirs)) nextPaths.add(watchPath);
  }

  for (const watchedPath of watchedLocalePaths) {
    if (nextPaths.has(watchedPath)) continue;
    fs.unwatchFile(watchedPath);
    watchedLocalePaths.delete(watchedPath);
  }

  for (const watchedPath of nextPaths) {
    if (watchedLocalePaths.has(watchedPath)) continue;
    watchedLocalePaths.add(watchedPath);
    fs.watchFile(watchedPath, { interval: localeWatchIntervalMs }, (current, previous) => {
      if (didWatchedFileChange(previous, current)) scheduleProjectReload();
    });
  }
}

function scheduleProjectReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadConfig();
    localeCacheByContext = new Map();
    watchLocalePaths();
    refreshOpenDocuments();
    refreshInlayHints();
  }, reloadDebounceMs);
}

function refreshOpenDocuments() {
  for (const doc of documents.all()) validate(doc);
}

function refreshInlayHints() {
  try {
    connection.languages.inlayHint.refresh?.();
  } catch (error) {
    connection.console.warn('Failed to refresh inlay hints: ' + error.message);
  }
}

function loadConfigIfChanged() {
  const configPath = resolveConfigPath(workspaceRoot);
  const nextMtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (configMtimeMs === nextMtimeMs) return;
  loadConfig();
  localeCacheByContext = new Map();
}

function loadConfig() {
  const configPath = resolveConfigPath(workspaceRoot);
  const settingsConfig = zedSettingsConfig;
  configMtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (!configMtimeMs) {
    config = normalizeI18nLensConfig(settingsConfig);
    return;
  }
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = normalizeI18nLensConfig(mergeI18nLensConfig(settingsConfig, fileConfig));
  } catch (error) {
    connection.console.warn('Failed to load ' + CONFIG_RELATIVE_PATH + ': ' + error.message);
    config = normalizeI18nLensConfig(settingsConfig);
  }
}

function normalizeIncomingSettings(value) {
  if (!value || typeof value !== 'object') return {};
  return value['i18n-lens'] && typeof value['i18n-lens'] === 'object' ? value['i18n-lens'] : value;
}

function validate(document) {
  const context = getProjectContext(document.uri);
  const { locales } = loadLocalesForContext(context);
  if (isSourceFile(document.uri)) {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: getDiagnostics(document.getText(), locales) });
    return;
  }
  const locale = findLocaleForFile(locales, fileURLToPath(document.uri));
  if (!locale) return;
  connection.sendDiagnostics({ uri: document.uri, diagnostics: getLocaleParamDiagnostics(locale, fileURLToPath(document.uri), document.getText(), locales) });
}
function isSourceFile(uri) { return /\.(vue|tsx?|jsx?)$/i.test(uri); }

const IGNORED_SCAN_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.output', '.next', '.nuxt', '.cache']);
const MAX_SCAN_FILES = 5000;

// Resolve the i18n key under `position`, whether the caret sits on a t()/keypath
// usage in source code or on a key inside a locale JSON/TS file.
function resolveKeyAtPosition(uri, position, context) {
  const filePath = fileURLToPath(uri);
  const text = documents.get(uri)?.getText() ?? readFileSafe(filePath);
  if (!text) return undefined;
  if (isSourceFile(uri)) return keyAtPosition(text, position)?.key;
  const { locales } = loadLocalesForContext(context);
  const locale = findLocaleForFile(locales, filePath);
  return locale ? localeKeyAtPosition(locale, filePath, text, position) : undefined;
}

function findLocaleForFile(locales, filePath) {
  const target = path.resolve(filePath);
  for (const locale of Object.values(locales)) {
    const files = locale.files?.length ? locale.files : (locale.path ? [locale.path] : []);
    if (files.some((file) => path.resolve(file) === target)) return locale;
  }
  return undefined;
}

// Every source-code usage of `key` within the project/package root. Prefers the
// in-memory text of open (possibly unsaved) documents over the on-disk copy.
function collectCodeReferences(context, key) {
  const openTextByPath = new Map();
  for (const doc of documents.all()) {
    try { openTextByPath.set(path.resolve(fileURLToPath(doc.uri)), doc.getText()); } catch { /* non-file uri */ }
  }
  const locations = [];
  for (const filePath of collectSourceFiles(context.root)) {
    const text = openTextByPath.get(path.resolve(filePath)) ?? readFileSafe(filePath);
    if (!text) continue;
    for (const range of findCodeKeyRanges(text, key)) {
      locations.push({ uri: pathToFileURL(filePath).toString(), range });
    }
  }
  return locations;
}

function collectSourceFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_SCAN_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_SCAN_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (isSourceFile(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
}

function getAllConfiguredContexts() {
  loadConfigIfChanged();
  return [resolveProjectContext(workspaceRoot, workspaceRoot, config), ...config.packages.map((pkg) => ({
    root: path.resolve(workspaceRoot, pkg.root),
    config: pkg,
  }))];
}

function loadLocalesForContext(context) {
  const cacheKey = context.root + '\0' + JSON.stringify({
    defaultLocale: context.config.defaultLocale,
    localeDirs: context.config.localeDirs,
    inlayHints: context.config.inlayHints,
  });
  const cached = localeCacheByContext.get(cacheKey);
  if (cached) return cached;

  const locales = {};
  const localeTexts = {};
  for (const dir of context.config.localeDirs) {
    const fullDir = path.join(context.root, dir);
    if (!fs.existsSync(fullDir)) continue;
    loadLocaleFiles(fullDir, locales, localeTexts);
    for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
      if (entry.isDirectory()) loadLocaleDirectory(path.join(fullDir, entry.name), entry.name, locales, localeTexts);
    }
  }
  const loaded = { locales, localeTexts };
  localeCacheByContext.set(cacheKey, loaded);
  return loaded;
}

function loadLocaleDirectory(localeDir, localeName, next, localeTexts) {
  next[localeName] ||= { path: localeDir, flat: {}, files: [] };
  for (const file of fs.readdirSync(localeDir)) {
    const fullPath = path.join(localeDir, file);
    if (fs.statSync(fullPath).isDirectory()) continue;
    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      if (file.endsWith('.json')) Object.assign(next[localeName].flat, prefixByFile(file, flattenLocale(JSON.parse(text))));
      else if (/\.[cm]?[tj]s$/i.test(file)) Object.assign(next[localeName].flat, parseTsLocaleModule(text, file));
      else continue;
      next[localeName].files.push(fullPath);
      localeTexts[fullPath] = text;
    } catch (error) { connection.console.warn('Failed to load locale file ' + fullPath + ': ' + error.message); }
  }
}

function loadLocaleFiles(fullDir, next, localeTexts) {
  for (const file of fs.readdirSync(fullDir)) {
    const fullPath = path.join(fullDir, file);
    if (fs.statSync(fullPath).isDirectory()) continue;
    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      if (file.endsWith('.json')) {
        const name = path.basename(file, '.json');
        next[name] = { path: fullPath, flat: flattenLocale(JSON.parse(text)), files: [fullPath] };
        localeTexts[fullPath] = text;
      }
    } catch (error) { connection.console.warn('Failed to load locale file ' + fullPath + ': ' + error.message); }
  }
}

function prefixByFile(file, flat) {
  const stem = path.basename(file, path.extname(file));
  if (stem === 'index') return flat;
  return Object.fromEntries(Object.entries(flat).map(([key, value]) => [stem + '.' + key, value]));
}

documents.listen(connection);
connection.listen();
