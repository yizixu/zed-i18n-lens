#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, MarkupKind, CodeActionKind, TextDocumentEdit, CreateFile, ResourceOperationKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  flattenLocale,
  buildHoverMarkdown,
  getDiagnostics,
  getRawTextDiagnostics,
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
  getExtractCodeActions,
  resolvePreferredLocale,
  getInlineCodeActions,
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
// Whether the client can apply WorkspaceEdit.documentChanges / CreateFile.
// Without documentChanges there is no versioned-edit support, so multi-file
// quick fixes are not offered at all rather than applied unsafely.
let clientSupportsDocumentChanges = false;
let clientSupportsCreateFile = false;
const configWatchIntervalMs = 1000;
const localeWatchIntervalMs = 1000;
const reloadDebounceMs = 100;

connection.onInitialize((params) => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri ? fileURLToPath(params.workspaceFolders[0].uri) : (params.rootUri ? fileURLToPath(params.rootUri) : process.cwd());
  zedSettingsConfig = normalizeIncomingSettings(params.initializationOptions);
  const editCaps = params.capabilities?.workspace?.workspaceEdit;
  clientSupportsDocumentChanges = editCaps?.documentChanges === true;
  clientSupportsCreateFile = clientSupportsDocumentChanges
    && Array.isArray(editCaps?.resourceOperations)
    && editCaps.resourceOperations.includes(ResourceOperationKind.Create);
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
  if (isLocaleDocument(event.document)) {
    // An open (possibly dirty) locale document overrides the disk copy, so a
    // previously cached load is stale the moment the file opens.
    invalidateLocaleCaches();
  }
  validate(event.document);
  // A freshly started server may receive the inlay-hint request before the
  // locale cache is ready; prompt the editor to re-request once it is.
  refreshInlayHints();
});

documents.onDidChangeContent((event) => {
  if (isLocaleDocument(event.document)) {
    // Open locale text feeds the cache, so it must be dropped now — the very
    // next request must already see this snapshot, not a debounced reload.
    invalidateLocaleCaches();
    refreshOpenDocuments();
    refreshInlayHints();
    return;
  }
  validate(event.document);
});

// An open locale document overrides the disk copy. Closing it reverts to
// disk, which is also a content change for every feature.
documents.onDidClose((event) => {
  if (!isLocaleDocument(event.document)) return;
  invalidateLocaleCaches();
  refreshOpenDocuments();
  refreshInlayHints();
});

documents.onDidSave(() => scheduleProjectReload());

connection.onDidChangeConfiguration((params) => {
  zedSettingsConfig = normalizeIncomingSettings(params.settings);
  scheduleProjectReload();
});

connection.onHover((params) => {
  if (isLocaleFileUri(params.textDocument.uri)) return null;
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
  if (!isSourceFile(params.textDocument.uri) || isLocaleFileUri(params.textDocument.uri)) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const prefix = getCompletionPrefix(doc.getText(), params.position);
  // undefined = caret is not inside an i18n call; '' = empty key prefix.
  if (prefix === undefined) return [];
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  return getCompletions(prefix, locales, context.config.defaultLocale);
});

connection.languages.inlayHint.on((params) => {
  if (!isSourceFile(params.textDocument.uri) || isLocaleFileUri(params.textDocument.uri)) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const context = getProjectContext(params.textDocument.uri);
  const { locales } = loadLocalesForContext(context);
  return getInlayHints(doc.getText(), params.range, locales, context.config.defaultLocale, context.config.inlayHints);
});

connection.onDefinition((params) => {
  if (isLocaleFileUri(params.textDocument.uri)) return null;
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const item = keyAtPosition(doc.getText(), params.position);
  if (!item) return null;
  const context = getProjectContext(params.textDocument.uri);
  const { locales, localeTexts } = loadLocalesForContext(context);
  const locations = collectLocaleKeyTargets(locales, item.key, localeTexts, context.config.defaultLocale)
    .map(({ filePath, range }) => ({ uri: pathToFileURL(filePath).toString(), range }));
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
    for (const { filePath, range } of collectLocaleKeyTargets(locales, key, localeTexts, context.config.defaultLocale)) {
      locations.push({ uri: pathToFileURL(filePath).toString(), range });
    }
  }
  return locations.length ? locations : null;
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  const diagnostics = params.context.diagnostics || [];
  const actions = [];
  if (clientSupportsDocumentChanges && doc && isSourceFile(params.textDocument.uri) && !isLocaleFileUri(params.textDocument.uri)) {
    for (const action of getParamCodeActions(doc.getText(), diagnostics)) {
      actions.push({
        title: action.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [action.diagnostic],
        edit: { documentChanges: [TextDocumentEdit.create({ uri: doc.uri, version: doc.version }, [action.edit])] },
      });
    }
  }
  actions.push(...getCreateKeyActions(diagnostics, getProjectContext(params.textDocument.uri)));
  if (clientSupportsDocumentChanges && doc && !isLocaleFileUri(doc.uri)) {
    // A refactor failure must not discard existing quick fixes or its sibling action.
    try { actions.push(...getExtractActions(doc, params, diagnostics)); }
    catch (error) { connection.console.error(`Extract failed for ${doc.uri}: ${error.message}`); }
    try { actions.push(...getInlineActions(doc, params)); }
    catch (error) { connection.console.error(`Inline failed for ${doc.uri}: ${error.message}`); }
  }
  return actions;
});

function getCreateKeyActions(diagnostics, context) {
  if (!clientSupportsDocumentChanges) return [];
  const { locales, localeTexts } = loadLocalesForContext(context);
  const actions = [];
  for (const diagnostic of diagnostics) {
    const key = diagnostic.data?.key;
    const missingLocales = diagnostic.data?.missingLocales;
    if (!key || !Array.isArray(missingLocales) || missingLocales.length === 0) continue;

    const missing = missingLocales.filter((name) => locales[name] && !Object.hasOwn(locales[name].flat, key));
    const plans = missing.map((name) => planKeyInsertion(key, locales[name], locales, localeTexts));
    // Do not offer a partial repair of a multi-locale diagnostic.
    if (!plans.length || plans.some((plan) => !plan || (plan.create && !clientSupportsCreateFile))) continue;
    const documentChanges = [];
    for (const plan of plans) {
      // If a file appeared after this action was computed, fail rather than
      // inserting into unrelated content at a stale offset.
      if (plan.create) documentChanges.push(CreateFile.create(plan.uri));
      documentChanges.push(TextDocumentEdit.create({ uri: plan.uri, version: plan.version }, [minimalTextEdit(plan.text, plan.newText)]));
    }
    actions.push({
      title: `Create i18n key "${key}" in ${plans.length} locale file(s)`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: { documentChanges },
    });
  }
  return actions;
}

function getExtractActions(doc, params, diagnostics) {
  const language = /\.vue$/i.test(doc.uri) ? 'vue' : /\.html?$/i.test(doc.uri) || doc.languageId === 'html' ? 'html' : undefined;
  if (!language) return [];
  const context = getProjectContext(doc.uri);
  const { locales, localeTexts } = loadLocalesForContext(context);
  const locale = resolvePreferredLocale(locales, context.config.defaultLocale);
  if (!locale) return [];
  return getExtractCodeActions(doc.getText(), language, fileURLToPath(doc.uri), params.range, diagnostics, locale.flat).flatMap((action) => {
    const plan = planKeyInsertion(action.key, locale, locales, localeTexts, action.value);
    if (!plan || (plan.create && !clientSupportsCreateFile)) return [];
    const documentChanges = [];
    if (plan.create) documentChanges.push(CreateFile.create(plan.uri));
    documentChanges.push(TextDocumentEdit.create({ uri: plan.uri, version: plan.version }, [minimalTextEdit(plan.text, plan.newText)]));
    documentChanges.push(TextDocumentEdit.create({ uri: doc.uri, version: doc.version }, [action.edit]));
    return [{ title: action.title, kind: CodeActionKind.QuickFix, diagnostics: [action.diagnostic], edit: { documentChanges } }];
  });
}

function getInlineActions(doc, params) {
  const { locales } = loadLocalesForContext(getProjectContext(doc.uri));
  return getInlineCodeActions(doc.getText(), params.range, locales).map((action) => ({
    title: action.title,
    kind: CodeActionKind.RefactorInline,
    edit: { documentChanges: [TextDocumentEdit.create({ uri: doc.uri, version: doc.version }, [action.edit])] },
  }));
}

// Namespace routing follows loaded file stems. Index-owned prefixes and
// overlapping layouts are not guessed; ambiguous targets disable the action.
function planKeyInsertion(key, locale, locales, localeTexts, value = '') {
  if (!locale) return undefined;
  if (!locale.directories?.length) {
    const files = locale.files || [];
    return files.length === 1 && /\.json$/i.test(files[0])
      ? insertInto(files[0], key, value) : undefined;
  }
  if (locale.directories.length !== 1 || locale.topLevelFiles?.length) return undefined;
  const directory = locale.directories[0];
  const targets = filesByPrefix(locale);
  const namespaceFiles = [...targets.keys()].filter((prefix) => prefix && key.startsWith(prefix + '.'));
  if (namespaceFiles.length > 1 || targets.has(key)) return undefined;
  const indexFiles = targets.get('') || [];
  const indexFile = indexFiles.length === 1 && /\.json$/i.test(indexFiles[0]) ? indexFiles[0] : undefined;
  let indexOwnsPrefix = false;
  if (indexFiles.length) {
    if (!indexFile) return undefined;
    try {
      const text = localeTexts[indexFile];
      const prefix = key.split('.')[0];
      // A whitespace-only index owns nothing; treat it like an empty object.
      indexOwnsPrefix = Object.keys(JSON.parse(text.trim() ? text : '{}'))
        .some((existing) => existing === prefix || existing.startsWith(prefix + '.'));
    } catch { return undefined; }
  }
  if (namespaceFiles.length) {
    if (indexOwnsPrefix) return undefined;
    const stem = namespaceFiles[0];
    const files = targets.get(stem);
    return files.length === 1 && /\.json$/i.test(files[0])
      ? insertInto(files[0], key.slice(stem.length + 1), value) : undefined;
  }
  if (indexOwnsPrefix) return insertInto(indexFile, key, value);

  const siblingStems = new Map();
  for (const sibling of Object.values(locales)) {
    if (sibling === locale || sibling.directories?.length !== 1 || sibling.topLevelFiles?.length) continue;
    for (const [stem, files] of filesByPrefix(sibling)) {
      if (!stem || !key.startsWith(stem + '.')) continue;
      siblingStems.set(stem, (siblingStems.get(stem) || []).concat(files.map((file) => ({
        file,
        relativePath: path.relative(sibling.directories[0], file),
      }))));
    }
  }
  if (siblingStems.size > 1) return undefined;
  if (siblingStems.size === 1) {
    const [stem, targets] = siblingStems.entries().next().value;
    if (targets.some(({ file }) => !/\.json$/i.test(file))) return undefined;
    const relativePaths = new Set(targets.map(({ relativePath }) => relativePath));
    if (relativePaths.size !== 1) return undefined;
    const targetPath = path.join(directory, [...relativePaths][0]);
    return fs.existsSync(path.dirname(targetPath))
      ? insertOrCreate(targetPath, key.slice(stem.length + 1), value) : undefined;
  }
  return indexFile ? insertInto(indexFile, key, value) : undefined;
}

function filesByPrefix(locale) {
  const prefixes = new Map();
  for (const file of locale.files || []) {
    const prefix = locale.filePrefixes[file];
    if (!prefixes.has(prefix)) prefixes.set(prefix, []);
    prefixes.get(prefix).push(file);
  }
  return prefixes;
}

function insertInto(filePath, lookupKey, value = '') {
  if (!lookupKey) return undefined;
  const text = openDocumentText(filePath) ?? readFileSafe(filePath);
  if (text === undefined) return undefined;
  // A whitespace-only file has no JSON structure to insert into; seed it like
  // an empty object (matching its line-ending style) so the fix still lands
  // instead of silently disappearing.
  const source = text.trim() ? text : (text.includes('\r\n') ? '{}\r\n' : '{}\n');
  const newText = insertNestedJsonKey(source, lookupKey, value);
  if (newText === undefined) return undefined;
  return toEditPlan(filePath, text, newText, false);
}

// Prefer an in-place insert when the file exists or is open as a buffer (the
// file may have been deleted on disk while its document stays alive); fall
// back to a CreateFile only when there is truly nothing to edit.
function insertOrCreate(filePath, lookupKey, value = '') {
  if (fs.existsSync(filePath) || openDocument(filePath)) return insertInto(filePath, lookupKey, value);
  return createIn(filePath, lookupKey, value);
}

// Create a missing namespace JSON file: only ever proposed with a CreateFile
// operation ahead of the text edit, and only when the file truly does not
// exist — never as a fallback guess.
function createIn(filePath, lookupKey, value = '') {
  if (!lookupKey || fs.existsSync(filePath) || openDocument(filePath)) return undefined;
  const newText = insertNestedJsonKey('{}\n', lookupKey, value);
  if (newText === undefined) return undefined;
  return toEditPlan(filePath, '', newText, true);
}

function toEditPlan(filePath, text, newText, create) {
  return { uri: pathToFileURL(filePath).toString(), version: documentVersion(filePath), text, newText, create };
}

// Smallest single edit turning `oldText` into `newText`: trim the shared
// prefix/suffix instead of replacing the whole document.
function minimalTextEdit(oldText, newText) {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) { endOld--; endNew--; }
  return { range: { start: offsetToPosition(oldText, start), end: offsetToPosition(oldText, endOld) }, newText: newText.slice(start, endNew) };
}

function offsetToPosition(text, offset) {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; lineStart = i + 1; }
  }
  return { line, character: offset - lineStart };
}

// Document version for an annotated TextDocumentEdit: the exact version for an
// open document, null when the file is not open in the editor.
function documentVersion(filePath) {
  return openDocument(filePath)?.version ?? null;
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
    for (const watchPath of collectLocaleWatchPaths(loaded.locales, [...configuredDirs, ...loaded.watchDirectories])) nextPaths.add(watchPath);
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

function invalidateLocaleCaches() {
  localeCacheByContext = new Map();
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
  invalidateLocaleCaches();
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
  const templateLanguage = /\.vue$/i.test(document.uri) ? 'vue'
    : /\.html?$/i.test(document.uri) || document.languageId === 'html' ? 'html' : undefined;
  if ((isSourceFile(document.uri) || templateLanguage) && !isLocaleFileUri(document.uri)) {
    const text = document.getText();
    const diagnostics = [
      ...getDiagnostics(text, locales),
      ...getRawTextDiagnostics(text, templateLanguage, context.config.rawTextDiagnostics),
    ];
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
    return;
  }
  const filePath = fileURLToPath(document.uri);
  const locale = findLocaleForFile(locales, filePath);
  if (!locale) return;
  connection.sendDiagnostics({ uri: document.uri, diagnostics: getLocaleParamDiagnostics(locale, filePath, document.getText(), locales) });
}

function isSourceFile(uri) { return /\.(vue|tsx?|jsx?)$/i.test(uri); }

const LOCALE_FILE_RE = /\.(json|[cm]?[tj]s)$/i;

// Is this file inside a localeDir of ANY configured context? Locale files are
// identified before source files: a TS locale module must never get source
// diagnostics, completions or inlay hints.
function localeDirOfFile(filePath) {
  const normalized = normalizeFsPathLocal(path.resolve(filePath));
  for (const context of getAllConfiguredContexts()) {
    const contextRoot = normalizeFsPathLocal(context.root);
    for (const dir of context.config.localeDirs || []) {
      const absDir = normalizeFsPathLocal(path.resolve(contextRoot, dir));
      if (!isPathInsidePath(normalized, absDir) || normalized === absDir) continue;
      const relative = normalized.slice(absDir.length + 1);
      return { context, dir: absDir, relative };
    }
  }
  return undefined;
}

function isLocaleFileUri(uri) {
  let filePath;
  try { filePath = fileURLToPath(uri); } catch { return false; }
  const info = localeDirOfFile(filePath);
  return !!info && LOCALE_FILE_RE.test(filePath);
}

function isLocaleDocument(document) {
  try { return isLocaleFileUri(document.uri); } catch { return false; }
}

const IGNORED_SCAN_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.output', '.next', '.nuxt', '.cache']);
const MAX_SCAN_FILES = 5000;

// Resolve the i18n key under `position`, whether the caret sits on a t()/keypath
// usage in source code or on a key inside a locale JSON/TS file.
function resolveKeyAtPosition(uri, position, context) {
  const filePath = fileURLToPath(uri);
  const text = documents.get(uri)?.getText() ?? readFileSafe(filePath);
  if (!text) return undefined;
  const { locales } = loadLocalesForContext(context);
  const locale = findLocaleForFile(locales, filePath);
  // Locale membership wins over the .ts source check: a caret on a key inside
  // en.ts / zh/index.ts must resolve to the flattened key, never to source
  // call sites (which would also spuriously match object literals).
  if (locale) return localeKeyAtPosition(locale, filePath, text, position);
  if (isSourceFile(uri) && !isLocaleFileUri(uri)) return keyAtPosition(text, position)?.key;
  return undefined;
}

function findLocaleForFile(locales, filePath) {
  const target = path.resolve(filePath);
  for (const locale of Object.values(locales)) {
    const files = locale.files?.length ? locale.files : (locale.path ? [locale.path] : []);
    if (files.some((file) => path.resolve(file) === target)) return locale;
  }
  return undefined;
}

// Every source-code usage of `key` inside this context only: files under the
// context root, excluding roots of other configured packages and locale
// directories, plus open (possibly unsaved) source documents belonging to the
// context that do not exist on disk yet. Open text wins over disk text.
function collectCodeReferences(context, key) {
  const contextRoot = normalizeFsPathLocal(context.root);
  const nestedRoots = getAllConfiguredContexts()
    .map((candidate) => normalizeFsPathLocal(candidate.root))
    .filter((root) => root !== contextRoot && isPathInsidePath(root, contextRoot));

  const locations = [];
  const scanned = new Set();
  const scan = (filePath, text, uri) => {
    const resolved = normalizeFsPathLocal(path.resolve(filePath));
    if (scanned.has(resolved)) return;
    scanned.add(resolved);
    if (text === undefined) return;
    for (const range of findCodeKeyRanges(text, key)) {
      locations.push({ uri: uri ?? pathToFileURL(filePath).toString(), range });
    }
  };

  for (const filePath of collectSourceFiles(context.root, nestedRoots)) {
    scan(filePath, openDocumentText(filePath) ?? readFileSafe(filePath));
  }

  for (const doc of documents.all()) {
    let filePath;
    try { filePath = fileURLToPath(doc.uri); } catch { continue; }
    if (!isSourceFile(filePath)) continue;
    const resolved = normalizeFsPathLocal(path.resolve(filePath));
    if (!isPathInsidePath(resolved, contextRoot)) continue;
    if (nestedRoots.some((root) => isPathInsidePath(resolved, root))) continue;
    if (isLocaleFileUri(doc.uri)) continue;
    scan(filePath, doc.getText(), doc.uri);
  }
  return locations;
}

function collectSourceFiles(root, excludedRoots = []) {
  const files = [];
  const stack = [root];
  const excluded = excludedRoots.map((entry) => normalizeFsPathLocal(entry));
  const localeDirs = getAllConfiguredContexts()
    .flatMap((context) => (context.config.localeDirs || [])
      .map((dir) => normalizeFsPathLocal(path.resolve(context.root, dir))));
  while (stack.length && files.length < MAX_SCAN_FILES) {
    const dir = stack.pop();
    const normalizedDir = normalizeFsPathLocal(dir);
    if (excluded.some((entry) => isPathInsidePath(normalizedDir, entry))) continue;
    if (localeDirs.some((entry) => normalizedDir === entry || normalizedDir.startsWith(entry + '/'))) continue;
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

function openDocument(filePath) {
  let target;
  try { target = path.resolve(filePath); } catch { return undefined; }
  for (const doc of documents.all()) {
    try {
      if (path.resolve(fileURLToPath(doc.uri)) === target) return doc;
    } catch { /* non-file uri */ }
  }
  return undefined;
}

// In-memory text of an open (possibly unsaved) document for filePath.
function openDocumentText(filePath) {
  return openDocument(filePath)?.getText();
}

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
}

// Prefer the open document's current text; fall back to disk.
function localeText(filePath) {
  return openDocumentText(filePath) ?? readFileSafe(filePath);
}

function normalizeFsPathLocal(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isPathInsidePath(filePath, root) {
  return filePath === root || filePath.startsWith(root + '/');
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
  const watchDirectories = new Set();
  const localeRoots = context.config.localeDirs.map((dir) => path.resolve(context.root, dir));
  for (const fullDir of localeRoots) {
    if (!fs.existsSync(fullDir)) continue;
    loadLocaleFiles(fullDir, locales, localeTexts);
    for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
      if (entry.isDirectory()) loadLocaleDirectory(path.join(fullDir, entry.name), entry.name, locales, localeTexts, localeRoots, watchDirectories);
    }
  }
  const loaded = { locales, localeTexts, watchDirectories: [...watchDirectories] };
  localeCacheByContext.set(cacheKey, loaded);
  return loaded;
}

function loadLocaleDirectory(localeDir, localeName, next, localeTexts, localeRoots, watchDirectories, rootDir = localeDir) {
  // An explicit locale root owns its subtree, independently of config order.
  if (localeRoots.includes(localeDir)) return;
  // Fileless directories still need watching, but must not create phantom locales.
  watchDirectories.add(localeDir);
  for (const entry of fs.readdirSync(localeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = entry.name;
    const fullPath = path.join(localeDir, file);
    if (entry.isDirectory()) {
      loadLocaleDirectory(fullPath, localeName, next, localeTexts, localeRoots, watchDirectories, rootDir);
      continue;
    }
    if (!LOCALE_FILE_RE.test(file)) continue;
    if (entry.isSymbolicLink() && fs.statSync(fullPath).isDirectory()) continue;
    next[localeName] ||= { path: rootDir, flat: {}, keyFiles: {}, files: [] };
    const locale = next[localeName];
    locale.directories ||= [];
    if (!locale.directories.includes(rootDir)) locale.directories.push(rootDir);
    locale.filePrefixes ||= {};
    const relativeFile = path.relative(rootDir, fullPath);
    if (!locale.files.includes(fullPath)) locale.files.push(fullPath);
    locale.filePrefixes[fullPath] = localeFilePrefix(relativeFile);
    try {
      const text = localeText(fullPath);
      if (text === undefined) continue;
      localeTexts[fullPath] = text;
      const flat = prefixByFile(relativeFile, file.endsWith('.json')
        ? flattenLocale(JSON.parse(text)) : parseTsLocaleModule(text, file));
      for (const [key, value] of Object.entries(flat)) {
        locale.flat[key] = value;
        locale.keyFiles[key] = fullPath;
      }
    } catch (error) { connection.console.warn('Failed to load locale file ' + fullPath + ': ' + error.message); }
  }
}

// Top-level locale files named after the locale itself (en.json, en.ts, …).
// Keys are stored verbatim — unlike directory locales no file-stem prefix is
// applied, so parseTsLocaleModule runs as an 'index' module. When both a .json
// and a .ts/.js file share the locale name, their keys merge (sorted read
// order keeps this deterministic); writing stays a JSON-only feature.
function loadLocaleFiles(fullDir, next, localeTexts) {
  const files = fs.readdirSync(fullDir).sort((a, b) => {
    const aJson = a.endsWith('.json') ? 0 : 1;
    const bJson = b.endsWith('.json') ? 0 : 1;
    return aJson - bJson || a.localeCompare(b);
  });
  for (const file of files) {
    const fullPath = path.join(fullDir, file);
    if (fs.statSync(fullPath).isDirectory()) continue;
    try {
      const isJson = file.endsWith('.json');
      const isModule = /\.[cm]?[tj]s$/i.test(file);
      if (!isJson && !isModule) continue;
      const name = file.replace(/\.(json|[cm]?[tj]s)$/i, '');
      next[name] ||= { path: fullPath, flat: {}, keyFiles: {}, files: [], topLevelFiles: [] };
      next[name].filePrefixes ||= {};
      next[name].filePrefixes[fullPath] = '';
      next[name].topLevelFiles ||= [];
      if (!next[name].files.includes(fullPath)) next[name].files.push(fullPath);
      if (!next[name].topLevelFiles.includes(fullPath)) next[name].topLevelFiles.push(fullPath);
      const text = localeText(fullPath);
      if (text === undefined) continue;
      localeTexts[fullPath] = text;
      const flat = isJson ? flattenLocale(JSON.parse(text)) : parseTsLocaleModule(text, 'index.ts');
      for (const [key, value] of Object.entries(flat)) {
        next[name].flat[key] = value;
        next[name].keyFiles[key] = fullPath;
      }
    } catch (error) { connection.console.warn('Failed to load locale file ' + fullPath + ': ' + error.message); }
  }
}

function prefixByFile(file, flat) {
  const prefix = localeFilePrefix(file);
  if (!prefix) return flat;
  return Object.fromEntries(Object.entries(flat).map(([key, value]) => [prefix + '.' + key, value]));
}

function localeFilePrefix(file) {
  const segments = file.replace(/\\/g, '/').split('/');
  const stem = segments.pop().replace(/\.[^.]+$/, '');
  if (stem !== 'index') segments.push(stem);
  return segments.join('.');
}

documents.listen(connection);
connection.listen();
