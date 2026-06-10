#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, MarkupKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  flattenLocale,
  buildHoverMarkdown,
  getDiagnostics,
  getCompletions,
  getCompletionPrefix,
  keyAtPosition,
  findJsonKeyLocation,
  parseTsLocaleModule,
  findLocaleKeyLocation,
  getInlayHints,
  normalizeI18nLensConfig,
  resolveConfigPath,
  CONFIG_RELATIVE_PATH,
  didWatchedFileChange,
  collectLocaleWatchPaths,
  getDefinitionLocaleOrder,
  resolveProjectContext,
} from './core.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspaceRoot = process.cwd();
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
  loadConfig();
  watchConfigFile();
  return { capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental, hoverProvider: true, completionProvider: { triggerCharacters: ['.', '"', "'"] }, definitionProvider: true, inlayHintProvider: true } };
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

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  return { contents: { kind: MarkupKind.Markdown, value: buildHoverMarkdown(item.key, locales) }, range: item.range };
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  const prefix = doc ? getCompletionPrefix(doc.getText(), params.position) : '';
  return getCompletions(prefix, locales, context.config.defaultLocale);
});

connection.languages.inlayHint.on((params) => {
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
  for (const locale of getDefinitionLocaleOrder(locales, context.config.defaultLocale)) {
    if (!Object.prototype.hasOwnProperty.call(locale.flat, item.key)) continue;
    for (const filePath of locale.files || [locale.path]) {
      const text = localeTexts[filePath];
      if (!text) continue;
      const pos = filePath.endsWith('.json') ? findJsonKeyLocation(text, item.key) : findLocaleKeyLocation(text, item.key);
      if (!pos) continue;
      return { uri: pathToFileURL(filePath).toString(), range: { start: pos, end: { line: pos.line, character: pos.character + item.key.split('.').at(-1).length + 2 } } };
    }
  }
  return null;
});

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
  configMtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (!configMtimeMs) {
    config = normalizeI18nLensConfig();
    return;
  }
  try {
    config = normalizeI18nLensConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    connection.console.warn('Failed to load ' + CONFIG_RELATIVE_PATH + ': ' + error.message);
    config = normalizeI18nLensConfig();
  }
}

function validate(document) {
  if (!isSourceFile(document.uri)) return;
  const context = getProjectContext(document.uri);
  const { locales } = loadLocalesForContext(context);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: getDiagnostics(document.getText(), locales) });
}
function isSourceFile(uri) { return /\.(vue|tsx?|jsx?)$/i.test(uri); }

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
