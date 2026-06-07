#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, MarkupKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { flattenLocale, buildHoverMarkdown, getDiagnostics, getCompletions, getCompletionPrefix, keyAtPosition, findJsonKeyLocation, parseTsLocaleModule, findLocaleKeyLocation, getInlayHints, normalizeI18nLensConfig, didWatchedFileChange, collectLocaleWatchPaths, getDefinitionLocaleOrder } from './core.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let workspaceRoot = process.cwd();
let localeCache = {};
let localeJsonCache = {};
let config = normalizeI18nLensConfig();
let watchedConfigPath;
const watchedLocalePaths = new Set();
let reloadTimer;
let configMtimeMs;
const configFileName = '.i18nlensrc.json';
const configWatchIntervalMs = 1000;
const localeWatchIntervalMs = 1000;
const reloadDebounceMs = 100;

connection.onInitialize((params) => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri ? fileURLToPath(params.workspaceFolders[0].uri) : (params.rootUri ? fileURLToPath(params.rootUri) : process.cwd());
  loadConfig();
  loadLocales();
  watchConfigFile();
  return { capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental, hoverProvider: true, completionProvider: { triggerCharacters: ['.', '"', "'"] }, definitionProvider: true, inlayHintProvider: true } };
});

connection.onInitialized(() => {
  // After (re)start the editor does not always re-request inlay hints for
  // already-open documents, so features only appeared after the first edit.
  // Proactively reload locales and ask the editor to refresh.
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
  loadConfigIfChanged();
  loadLocales();
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  return { contents: { kind: MarkupKind.Markdown, value: buildHoverMarkdown(item.key, localeCache) }, range: item.range };
});

connection.onCompletion((params) => {
  loadConfigIfChanged();
  loadLocales();
  const doc = documents.get(params.textDocument.uri);
  const prefix = doc ? getCompletionPrefix(doc.getText(), params.position) : '';
  return getCompletions(prefix, localeCache, config.defaultLocale);
});


connection.languages.inlayHint.on((params) => {
  loadConfigIfChanged();
  loadLocales();
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return getInlayHints(doc.getText(), params.range, localeCache, config.defaultLocale, config.inlayHints);
});

connection.onDefinition((params) => {
  loadConfigIfChanged();
  loadLocales();
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  for (const locale of getDefinitionLocaleOrder(localeCache, config.defaultLocale)) {
    if (!Object.prototype.hasOwnProperty.call(locale.flat, item.key)) continue;
    for (const filePath of locale.files || [locale.path]) {
      const text = localeJsonCache[filePath];
      if (!text) continue;
      const pos = filePath.endsWith('.json') ? findJsonKeyLocation(text, item.key) : findLocaleKeyLocation(text, item.key);
      if (!pos) continue;
      return { uri: pathToFileURL(filePath).toString(), range: { start: pos, end: { line: pos.line, character: pos.character + item.key.split('.').at(-1).length + 2 } } };
    }
  }
  return null;
});


function watchConfigFile() {
  const configPath = path.join(workspaceRoot, configFileName);
  if (watchedConfigPath === configPath) return;
  if (watchedConfigPath) fs.unwatchFile(watchedConfigPath);
  watchedConfigPath = configPath;
  fs.watchFile(configPath, { interval: configWatchIntervalMs }, (current, previous) => {
    if (didWatchedFileChange(previous, current)) scheduleProjectReload();
  });
}

function watchLocalePaths() {
  const configuredDirs = config.localeDirs
    .map((dir) => path.join(workspaceRoot, dir))
    .filter((dir) => fs.existsSync(dir));
  const nextPaths = new Set(collectLocaleWatchPaths(localeCache, configuredDirs));

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
    loadLocales();
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
  const configPath = path.join(workspaceRoot, configFileName);
  const nextMtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (configMtimeMs === nextMtimeMs) return;
  loadConfig();
}

function loadConfig() {
  const configPath = path.join(workspaceRoot, configFileName);
  configMtimeMs = fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  if (!configMtimeMs) {
    config = normalizeI18nLensConfig();
    return;
  }
  try {
    config = normalizeI18nLensConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    connection.console.warn('Failed to load .i18nlensrc.json: ' + error.message);
    config = normalizeI18nLensConfig();
  }
}

function validate(document) {
  if (!isSourceFile(document.uri)) return;
  loadConfigIfChanged();
  loadLocales();
  connection.sendDiagnostics({ uri: document.uri, diagnostics: getDiagnostics(document.getText(), localeCache) });
}
function isSourceFile(uri) { return /\.(vue|tsx?|jsx?)$/i.test(uri); }
function loadLocales() {
  loadConfigIfChanged();
  const next = {};
  const jsons = {};
  for (const dir of config.localeDirs) {
    const fullDir = path.join(workspaceRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    loadLocaleFiles(fullDir, next, jsons);
    for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
      if (entry.isDirectory()) loadLocaleDirectory(path.join(fullDir, entry.name), entry.name, next, jsons);
    }
  }
  localeCache = next;
  localeJsonCache = jsons;
  watchLocalePaths();
}

function loadLocaleDirectory(localeDir, localeName, next, jsons) {
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
      jsons[fullPath] = text;
    } catch (error) { connection.console.warn('Failed to load locale file ' + fullPath + ': ' + error.message); }
  }
}

function loadLocaleFiles(fullDir, next, jsons) {
  for (const file of fs.readdirSync(fullDir)) {
    const fullPath = path.join(fullDir, file);
    if (fs.statSync(fullPath).isDirectory()) continue;
    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      if (file.endsWith('.json')) {
        const name = path.basename(file, '.json');
        next[name] = { path: fullPath, flat: flattenLocale(JSON.parse(text)), files: [fullPath] };
        jsons[fullPath] = text;
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
