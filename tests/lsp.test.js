import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseDocument, DomUtils } from 'htmlparser2';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';

const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url));
const position = { line: 0, character: 4 };
const range = { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } };

async function startServer(t, files, settings = {}, workspaceEdit = { documentChanges: true, resourceOperations: ['create'] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-lens-lsp-'));
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  const child = spawn(process.execPath, [serverPath, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const pending = new Map();
  const diagnostics = new Map();
  const logs = [];
  const waiters = new Set();
  let initializedRefresh;
  const ready = new Promise((resolve) => { initializedRefresh = resolve; });
  let serial = 0;
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + size) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + size).toString());
      buffer = buffer.subarray(headerEnd + 4 + size);
      if (message.method && message.id !== undefined) {
        if (message.method === 'workspace/inlayHint/refresh') initializedRefresh();
        send({ id: message.id, result: null });
      } else if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else if (message.method === 'window/logMessage') {
        logs.push(message.params);
      } else if (message.method === 'textDocument/publishDiagnostics') {
        diagnostics.set(message.params.uri, message.params.diagnostics);
        for (const check of [...waiters]) check(message.params.uri, message.params.diagnostics);
      }
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}\n${stderr}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  // Kill before removing fixtures, including on a failed assertion or handshake.
  t.after(async () => {
    child.kill();
    await closed;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    await fs.rm(root, { recursive: true, force: true });
  });
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const call = (method, name, params = {}) => request(method, { textDocument: { uri: uri(name) }, ...params });
  const sync = (name) => call('textDocument/hover', name, { position });
  function nextDiagnostics(name, predicate = () => true, timeoutMs = 5000) {
    const target = uri(name);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for diagnostics: ${target}`));
      }, timeoutMs);
      const check = (u, items) => {
        if (u !== target || !predicate(items)) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(items);
      };
      waiters.add(check);
    });
  }
  function languageId(name) {
    if (name.endsWith('.vue')) return 'vue';
    if (/\.html?$/i.test(name)) return 'html';
    return 'typescript';
  }
  async function open(name, text, version = 1) {
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri: uri(name), languageId: languageId(name), version, text } } });
    await sync(name);
  }
  function configure(settings) {
    send({ method: 'workspace/didChangeConfiguration', params: { settings: { 'i18n-lens': settings } } });
  }
  async function change(name, text, version) {
    send({ method: 'textDocument/didChange', params: { textDocument: { uri: uri(name), version }, contentChanges: [{ text }] } });
    await sync(name);
  }
  const actions = (name) => call('textDocument/codeAction', name, { range, context: { diagnostics: diagnostics.get(uri(name)) || [] } });
  await request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: { workspace: { workspaceEdit, inlayHint: { refreshSupport: true } } },
    initializationOptions: { defaultLocale: 'en', ...settings },
  });
  send({ method: 'initialized', params: {} });
  return { root, uri, call, open, change, configure, sync, send, diagnostics, actions, nextDiagnostics, ready, logs };
}

function documentEdits(action) {
  return action.edit.documentChanges.filter((change) => change.textDocument);
}

function applyText(text, change) {
  const document = TextDocument.create(change.textDocument.uri, 'json', change.textDocument.version ?? 0, text);
  return TextDocument.applyEdits(document, change.edits);
}

test('create-key edits preserve unsaved locale contents and bind the current document version', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Disk"}', 'src/app.ts': source });
  const unsaved = '{\r\n  "known": "Edited",\r\n  "unsaved": "Keep me"\r\n}\r\n';
  await s.open('locales/en.json', unsaved, 7);
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'missing key has a safe creation action');
  const [change] = documentEdits(action);
  assert.deepEqual(change.textDocument, { uri: s.uri('locales/en.json'), version: 7 });
  const updated = applyText(unsaved, change);
  assert.deepEqual(JSON.parse(updated), { known: 'Edited', unsaved: 'Keep me', missing: '' });
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false, 'preserves CRLF');
  assert.notDeepEqual(change.edits[0].range.start, { line: 0, character: 0 }, 'does not replace the whole document');
  await s.change('locales/en.json', updated, 8);
  await s.sync('src/app.ts');
  assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
});

test('directory creation strips the namespace and preserves index translations', async (t) => {
  const source = "t('common.submit')";
  const files = {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/zh/common.json': '{"known":"已知"}',
    'locales/en/index.json': '{"home":"Home"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  };
  const s = await startServer(t, files);
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const edits = documentEdits(action);
  assert.deepEqual(edits.map((edit) => edit.textDocument.uri).sort(), [s.uri('locales/en/common.json'), s.uri('locales/zh/common.json')].sort());
  for (const edit of edits) {
    const original = await fs.readFile(fileURLToPath(edit.textDocument.uri), 'utf8');
    assert.deepEqual(JSON.parse(applyText(original, edit)), { ...JSON.parse(original), submit: '' });
  }
});

test('a missing namespace file is created from an unambiguous sibling-locale layout', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const operations = action.edit.documentChanges;
  assert.equal(operations[0].kind, 'create');
  assert.equal(operations[0].uri, s.uri('locales/zh/common.json'));
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
  assert.equal(edit.textDocument.uri, operations[0].uri);
  assert.equal(edit.textDocument.version, null);
});

test('namespace creation refuses ambiguous JSON and TS targets', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/en/common.ts': "export default { other: 'Other' };",
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('missing-file creation requires client resource-operation support', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  }, {}, { documentChanges: true });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('clients without versioned document-edit support receive no unsafe create action', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '{}', 'src/app.ts': source }, {}, {});
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('an empty locale file is seeded instead of silently dropping the fix', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'missing key in an empty file still offers a fix');
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { missing: '' });
});

test('an empty namespace file is seeded instead of creating a duplicate', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/common.json': '',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  assert.equal(action.edit.documentChanges.every((op) => op.kind !== 'create'), true, 'no CreateFile for an existing file');
  const [edit] = documentEdits(action);
  assert.equal(edit.textDocument.uri, s.uri('locales/zh/common.json'));
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
});

test('seeding a whitespace-only file keeps its CRLF style', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '\r\n', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const [edit] = documentEdits(action);
  const updated = applyText('\r\n', edit);
  assert.deepEqual(JSON.parse(updated), { missing: '' });
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false, 'keeps CRLF');
});

test('a namespace buffer whose file is absent is edited instead of recreated', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const buffer = '{\r\n  "known": "已知"\r\n}\r\n';
  await s.open('locales/zh/common.json', buffer, 3);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'a live buffer for the missing file still offers the fix');
  assert.equal(action.edit.documentChanges.every((op) => op.kind !== 'create'), true, 'edits the buffer instead of creating the file');
  const [edit] = documentEdits(action);
  assert.equal(edit.textDocument.uri, s.uri('locales/zh/common.json'));
  assert.equal(edit.textDocument.version, 3);
  assert.deepEqual(JSON.parse(applyText(buffer, edit)), { known: '已知', submit: '' });
});

test('hover follows unsaved locale changes and reverts to disk on close', async (t) => {
  const source = "t('known')";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Disk"}', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  await s.open('locales/en.json', '{"known":"Opened"}');
  assert.match((await s.sync('src/app.ts')).contents.value, /Opened/);
  await s.change('locales/en.json', '{"known":"Changed"}', 2);
  assert.match((await s.sync('src/app.ts')).contents.value, /Changed/);
  s.send({ method: 'textDocument/didClose', params: { textDocument: { uri: s.uri('locales/en.json') } } });
  assert.match((await s.sync('src/app.ts')).contents.value, /Disk/);
});

test('top-level and directory TS locales support reverse references without source completions', async (t) => {
  const source = "t('known')";
  const module = "export default { known: 'Known' };";
  const s = await startServer(t, { 'locales/en.ts': module, 'locales/zh/index.ts': module, 'src/app.ts': source });
  await s.open('src/app.ts', source);
  assert.match((await s.sync('src/app.ts')).contents.value, /Known/);
  for (const name of ['locales/en.ts', 'locales/zh/index.ts']) {
    await s.open(name, module);
    const references = await s.call('textDocument/references', name, { position: { line: 0, character: module.indexOf('known') + 1 }, context: { includeDeclaration: false } });
    assert.deepEqual(references.map((ref) => ref.uri), [s.uri('src/app.ts')]);
    assert.deepEqual(await s.call('textDocument/completion', name, { position }), []);
    assert.deepEqual(await s.call('textDocument/inlayHint', name, { range }), []);
  }
});

test('references isolate nested package contexts and include new unsaved source documents', async (t) => {
  const source = "t('shared')";
  const s = await startServer(t, {
    'locales/en.json': '{"shared":"Root"}',
    'src/root.ts': source,
    'apps/web/locales/en.json': '{"shared":"Child"}',
    'apps/web/src/child.ts': source,
  }, { packages: [{ root: 'apps/web', localeDirs: ['locales'] }] });
  await s.open('src/root.ts', source);
  await s.open('src/unsaved.ts', source);
  await s.open('apps/web/src/child.ts', source);
  const rootRefs = await s.call('textDocument/references', 'src/root.ts', { position, context: { includeDeclaration: false } });
  assert.deepEqual(rootRefs.map((ref) => ref.uri).sort(), [s.uri('src/root.ts'), s.uri('src/unsaved.ts')].sort());
  const childRefs = await s.call('textDocument/references', 'apps/web/src/child.ts', { position, context: { includeDeclaration: false } });
  assert.deepEqual(childRefs.map((ref) => ref.uri), [s.uri('apps/web/src/child.ts')]);
});

test('comments and dynamic keys produce no diagnostics or references, and completion stays contextual', async (t) => {
  const source = "// t('ghost')\nconst text = \"t('quoted')\";\nt('prefix.' + name);\nt('known');\nconst unrelated = 1;\nt('";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Known"}', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
  assert.deepEqual(await s.call('textDocument/completion', 'src/app.ts', { position: { line: 4, character: 20 } }), []);
  const completions = await s.call('textDocument/completion', 'src/app.ts', { position: { line: 5, character: 3 } });
  assert.deepEqual(completions.map((item) => item.label), ['known']);
  const refs = await s.call('textDocument/references', 'src/app.ts', { position: { line: 0, character: 8 }, context: { includeDeclaration: false } });
  assert.equal(refs, null);
});

test('JSON definition and creation target the correct sibling object', async (t) => {
  const locale = '{"a":{"b":{"c":"Inner"}},"b":{"c":"Outer"}}';
  const source = "t('b.c'); t('b.d')";
  const s = await startServer(t, { 'locales/en.json': locale, 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const locations = await s.call('textDocument/definition', 'src/app.ts', { position });
  assert.equal(locations[0].range.start.character, locale.lastIndexOf('"c"'));
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText(locale, edit)), { a: { b: { c: 'Inner' } }, b: { c: 'Outer', d: '' } });
});

test('TS locale diagnostics validate translations rather than treating the file as source', async (t) => {
  const en = "export default { greeting: 'Hi {name}' };";
  const zh = "export default { greeting: '你好' };";
  const s = await startServer(t, { 'locales/en.ts': en, 'locales/zh.ts': zh });
  await s.open('locales/en.ts', en);
  const diagnostics = s.diagnostics.get(s.uri('locales/en.ts'));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].data.key, 'greeting');
  assert.deepEqual(diagnostics[0].data.paramInconsistency.map((entry) => ({ name: entry.name, params: entry.params })), [
    { name: 'en', params: ['name'] },
    { name: 'zh', params: [] },
  ]);
  await s.open('locales/zh.ts', "export default { greeting: '你好 {name}' };");
  await s.sync('locales/en.ts');
  assert.deepEqual(s.diagnostics.get(s.uri('locales/en.ts')), []);
});

test('namespace creation refuses an empty index-owned namespace', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/en/index.json': '{"common":{}}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('creation never repairs only the writable half of a multi-locale diagnostic', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, {
    'locales/en.json': '{}',
    'locales/zh.ts': "export default { known: '已知' };",
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('stdio LSP publishes opt-in template diagnostics and clears them on settings/content changes', { timeout: 15000 }, async (t) => {
  // No locale files: raw text diagnostics must not depend on locale discovery.
  const s = await startServer(t, {});

  let pending = s.nextDiagnostics('RawText.vue');
  await s.open('RawText.vue', '<template><button>Save changes</button></template>');
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.vue', (items) => items.some((item) => item.code === 'raw-text'));
  s.configure({ rawTextDiagnostics: true });
  assert.equal((await pending).length, 1);

  pending = s.nextDiagnostics('RawText.html');
  await s.open('RawText.html', '<input placeholder="Enter name">');
  assert.equal((await pending)[0].code, 'raw-text');

  pending = s.nextDiagnostics('RawText.js');
  await s.open('RawText.js', 'const label = "Save changes";');
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.vue');
  await s.change('RawText.vue', '<template><button>{{ t("save") }}</button></template>', 2);
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.html', (items) => items.length === 0);
  s.configure({ rawTextDiagnostics: false });
  assert.deepEqual(await pending, []);
});

test('nested locale directories preserve namespaces for JSON, TS, JS, and index files', async (t) => {
  const cases = [
    ['system.title', 'System', 'system/index.json'],
    ['system.user.name', 'User', 'system/user.json'],
    ['admin.user.name', 'Administrator', 'admin/user.json'],
    ['system.forms.fields.label', 'Name', 'system/forms/fields.ts'],
    ['system.messages.saved', 'Saved', 'system/messages.js'],
  ];
  const source = cases.map(([key]) => `t('${key}')`).join('\n');
  const s = await startServer(t, {
    'locales/en/system/index.json': '{"title":"System"}',
    'locales/en/system/user.json': '{"name":"User"}',
    'locales/en/admin/user.json': '{"name":"Administrator"}',
    'locales/en/system/forms/fields.ts': "export default { label: 'Name' };",
    'locales/en/system/messages.js': "export default { saved: 'Saved' };",
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
  for (const [line, [, text, file]] of cases.entries()) {
    const caret = { line, character: 4 };
    assert.match((await s.call('textDocument/hover', 'src/app.ts', { position: caret })).contents.value, new RegExp(text));
    const [definition] = await s.call('textDocument/definition', 'src/app.ts', { position: caret });
    assert.equal(definition.uri, s.uri('locales/en/' + file));
  }
  const hints = await s.call('textDocument/inlayHint', 'src/app.ts', { range });
  assert.deepEqual(hints.map((hint) => hint.label), cases.map(([, text]) => text));
  await s.open('src/completion.ts', "t('system.");
  const completions = await s.call('textDocument/completion', 'src/completion.ts', { position: { line: 0, character: 10 } });
  assert.deepEqual(completions.map((item) => item.label).sort(), cases.map(([key]) => key).filter((key) => key.startsWith('system.')).sort());
});

test('nested locale buffers refresh translations and resolve reverse references', async (t) => {
  const source = "t('system.user.name')";
  const s = await startServer(t, {
    'locales/en/system/user.json': '{"name":"Disk"}',
    'src/app.ts': source,
    'src/other.ts': "t('admin.user.name')",
  });
  await s.open('src/app.ts', source);
  const edited = '{"name":"Edited"}';
  await s.open('locales/en/system/user.json', edited, 3);
  assert.match((await s.sync('src/app.ts')).contents.value, /Edited/);
  const references = await s.call('textDocument/references', 'locales/en/system/user.json', {
    position: { line: 0, character: edited.indexOf('name') }, context: { includeDeclaration: false },
  });
  assert.deepEqual(references.map((ref) => ref.uri), [s.uri('src/app.ts')]);
  assert.deepEqual(await s.call('textDocument/completion', 'locales/en/system/user.json', { position }), []);
  assert.deepEqual(await s.call('textDocument/inlayHint', 'locales/en/system/user.json', { range }), []);
  await s.change('locales/en/system/user.json', '{"name":"Changed"}', 4);
  assert.match((await s.sync('src/app.ts')).contents.value, /Changed/);
  s.send({ method: 'textDocument/didClose', params: { textDocument: { uri: s.uri('locales/en/system/user.json') } } });
  assert.match((await s.sync('src/app.ts')).contents.value, /Disk/);
});

test('nested locale param diagnostics stay in the owning namespace', async (t) => {
  const system = '{"greeting":"Hi {name}"}';
  const admin = '{"greeting":"Admin {name}"}';
  const s = await startServer(t, {
    'locales/en/system/user.json': system,
    'locales/zh/system/user.json': '{"greeting":"你好"}',
    'locales/en/admin/user.json': admin,
    'locales/zh/admin/user.json': '{"greeting":"管理员 {name}"}',
  });
  await s.open('locales/en/admin/user.json', admin);
  assert.deepEqual(s.diagnostics.get(s.uri('locales/en/admin/user.json')), []);
  await s.open('locales/en/system/user.json', system);
  const diagnostics = s.diagnostics.get(s.uri('locales/en/system/user.json'));
  assert.deepEqual(diagnostics.map((item) => item.data.key), ['system.user.greeting']);
  await s.open('locales/zh/system/user.json', '{"greeting":"你好 {name}"}');
  await s.sync('locales/en/system/user.json');
  assert.deepEqual(s.diagnostics.get(s.uri('locales/en/system/user.json')), []);
});

test('nested namespace creation edits existing files without duplicating their prefix', async (t) => {
  const source = "t('system.user.submit')";
  const files = {
    'locales/en/system/user.json': '{"name":"User"}',
    'locales/zh/system/user.json': '{"name":"用户"}',
    'src/app.ts': source,
  };
  const s = await startServer(t, files);
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const edits = documentEdits(action);
  assert.deepEqual(edits.map((edit) => edit.textDocument.uri).sort(), [s.uri('locales/en/system/user.json'), s.uri('locales/zh/system/user.json')].sort());
  for (const edit of edits) {
    const original = await fs.readFile(fileURLToPath(edit.textDocument.uri), 'utf8');
    assert.deepEqual(JSON.parse(applyText(original, edit)), { ...JSON.parse(original), submit: '' });
  }
});

test('a missing nested namespace file follows the sibling locale directory layout', async (t) => {
  const source = "t('system.user.submit')";
  const s = await startServer(t, {
    'locales/en/system/user.json': '{"submit":"Submit"}',
    'locales/zh/system/other.json': '{"title":"其他"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  assert.equal(action.edit.documentChanges[0].kind, 'create');
  assert.equal(action.edit.documentChanges[0].uri, s.uri('locales/zh/system/user.json'));
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
});

test('nested namespace creation refuses inconsistent sibling directory layouts', async (t) => {
  const source = "t('system.user.submit')";
  const s = await startServer(t, {
    'locales/en/system/user.json': '{"submit":"Submit"}',
    'locales/fr/system.user.json': '{"submit":"Envoyer"}',
    'locales/zh/system/other.json': '{"title":"其他"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('new files in nested locale directories automatically refresh translations', { timeout: 15000 }, async (t) => {
  const source = "t('system.notice.saved')";
  const s = await startServer(t, {
    'locales/en/system/user.json': '{"name":"User"}',
    'locales/zh/system/user.json': '{"name":"用户"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.equal(s.diagnostics.get(s.uri('src/app.ts')).length, 1);
  const refreshed = s.nextDiagnostics('src/app.ts', (items) => items.length === 0, 10000);
  await fs.writeFile(path.join(s.root, 'locales/en/system/notice.json'), '{"saved":"Saved"}');
  await fs.writeFile(path.join(s.root, 'locales/zh/system/notice.json'), '{"saved":"已保存"}');
  await refreshed;
  assert.match((await s.sync('src/app.ts')).contents.value, /Saved/);
  assert.deepEqual((await s.call('textDocument/inlayHint', 'src/app.ts', { range })).map((hint) => hint.label), ['Saved']);
});

test('non-index TS and JS locales preserve default exports without exposing helpers', async (t) => {
  for (const file of ['common.ts', 'common.js', 'system/common.ts', 'system/common.js']) {
    await t.test(file, async (t) => {
      const prefix = file.replace(/\.[^.]+$/, '').replace(/\//g, '.');
      const source = `t('${prefix}.button.save')\nt('${prefix}.internal.debug')`;
      const module = "const button = { save: 'Save' };\nconst internal = { debug: 'Debug only' };\nexport default { button: { save: 'Save changes' } };";
      const s = await startServer(t, { ['locales/en/' + file]: module, 'src/app.ts': source });
      await s.open('src/app.ts', source);
      const hints = await s.call('textDocument/inlayHint', 'src/app.ts', { range });
      assert.deepEqual(hints.map((hint) => hint.label), ['Save changes']);
      assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')).map((item) => item.data.key), [`${prefix}.internal.debug`]);
      await s.open('src/completion.ts', `t('${prefix}.`);
      const completions = await s.call('textDocument/completion', 'src/completion.ts', {
        position: { line: 0, character: prefix.length + 4 },
      });
      assert.deepEqual(completions.map((item) => item.label), [`${prefix}.button.save`]);
    });
  }
});

test('index-directory creation strips its namespace and preserves the root index', async (t) => {
  for (const withRootIndex of [false, true]) {
    await t.test(`root index: ${withRootIndex}`, async (t) => {
      const source = "t('index.submit')";
      const files = { 'src/app.ts': source };
      for (const locale of ['en', 'zh']) {
        files[`locales/${locale}/index/index.json`] = '{"name":"Home"}';
        if (withRootIndex) files[`locales/${locale}/index.json`] = '{"home":"Keep me"}';
      }
      const s = await startServer(t, files);
      for (const locale of ['en', 'zh']) {
        const name = `locales/${locale}/index/index.json`;
        await s.open(name, files[name]);
      }
      await s.open('src/app.ts', source);
      const [action] = await s.actions('src/app.ts');
      assert.ok(action, 'the index namespace has an unambiguous creation target');
      const edits = documentEdits(action);
      assert.deepEqual(edits.map((edit) => edit.textDocument.uri).sort(),
        ['en', 'zh'].map((locale) => s.uri(`locales/${locale}/index/index.json`)).sort());
      for (const edit of edits) {
        const name = path.relative(s.root, fileURLToPath(edit.textDocument.uri));
        const original = await fs.readFile(fileURLToPath(edit.textDocument.uri), 'utf8');
        const updated = applyText(original, edit);
        assert.deepEqual(JSON.parse(updated), { name: 'Home', submit: '' });
        await s.change(name, updated, 2);
      }
      assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
      if (withRootIndex) {
        for (const locale of ['en', 'zh']) {
          assert.equal(await fs.readFile(path.join(s.root, `locales/${locale}/index.json`), 'utf8'), '{"home":"Keep me"}');
        }
      }
    });
  }
});

test('a missing index-directory file follows the sibling locale layout', async (t) => {
  const source = "t('index.submit')";
  const s = await startServer(t, {
    'locales/en/index/index.json': '{"submit":"Submit"}',
    'locales/zh/index/other.json': '{"name":"其他"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  assert.equal(action.edit.documentChanges[0].kind, 'create');
  assert.equal(action.edit.documentChanges[0].uri, s.uri('locales/zh/index/index.json'));
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
});

test('nested definitions follow the effective translation after merging and unsaved edits', async (t) => {
  for (const file of ['system.user.json', 'system/user.json']) {
    await t.test(file, async (t) => {
      const source = "t('system.user.name')";
      const owner = 'locales/en/' + file;
      const index = 'locales/en/system/index.json';
      const s = await startServer(t, {
        [index]: '{"user":{"name":"Shadow"}}',
        [owner]: '{"name":"Actual"}',
        'src/app.ts': source,
      });
      await s.open('src/app.ts', source);
      async function check(text, expectedFile) {
        assert.match((await s.sync('src/app.ts')).contents.value, new RegExp(text));
        const definitions = await s.call('textDocument/definition', 'src/app.ts', { position });
        assert.deepEqual(definitions.map((item) => item.uri), [s.uri(expectedFile)]);
        const references = await s.call('textDocument/references', 'src/app.ts', {
          position, context: { includeDeclaration: true },
        });
        assert.deepEqual(references.filter((item) => item.uri !== s.uri('src/app.ts')).map((item) => item.uri), [s.uri(expectedFile)]);
      }
      await check('Actual', owner);
      await s.open(owner, '{}');
      await check('Shadow', index);
      s.send({ method: 'textDocument/didClose', params: { textDocument: { uri: s.uri(owner) } } });
      await check('Actual', owner);
    });
  }
});

test('overlapping locale roots keep reverse references in the explicitly configured root', async (t) => {
  const nestedRoots = ['locales/modules', 'locales/modules/features', 'locales/modules/features/messages'];
  for (const nestedRoot of nestedRoots) {
    for (const localeDirs of [['locales', nestedRoot], [nestedRoot, 'locales']]) {
      await t.test(localeDirs.join(', '), async (t) => {
        const source = "t('user.name')\nt('en.user.name')";
        const localeFile = nestedRoot + '/en/user.json';
        const s = await startServer(t, {
          [localeFile]: '{"name":"User"}',
          'src/app.ts': source,
        }, { localeDirs });
        await s.open('src/app.ts', source);
        async function check() {
          const references = await s.call('textDocument/references', localeFile, {
            position: { line: 0, character: 3 }, context: { includeDeclaration: false },
          });
          const expected = await s.call('textDocument/references', 'src/app.ts', {
            position, context: { includeDeclaration: false },
          });
          assert.deepEqual(references, expected);
          assert.deepEqual(references.map((item) => item.range.start.line), [0]);
          assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')).filter((item) => item.data.key === 'user.name'), []);
          assert.doesNotMatch((await s.sync('src/app.ts')).contents.value, /\| modules \|/);
        }
        await check();
        await s.open(localeFile, '{"name":"Opened"}');
        await s.change(localeFile, '{"name":"Unsaved"}', 2);
        assert.match((await s.sync('src/app.ts')).contents.value, /Unsaved/);
        await check();
      });
    }
  }
});

test('deeply overlapping roots retain empty locale files as real missing-key targets', async (t) => {
  for (const emptyText of ['', '{}']) {
    await t.test(JSON.stringify(emptyText), async (t) => {
      const source = "t('user.name')";
      const s = await startServer(t, {
        'locales/modules/features/en/user.json': '{"name":"User"}',
        'locales/modules/features/zh/user.json': emptyText,
        'src/app.ts': source,
      }, { localeDirs: ['locales', 'locales/modules/features'] });
      await s.open('src/app.ts', source);
      const diagnostics = s.diagnostics.get(s.uri('src/app.ts'));
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(diagnostics[0].data.missingLocales, ['zh']);
      const [action] = await s.actions('src/app.ts');
      assert.ok(action, 'an empty locale file remains a writable target');
      const [edit] = documentEdits(action);
      assert.equal(edit.textDocument.uri, s.uri('locales/modules/features/zh/user.json'));
      const updated = applyText(emptyText, edit);
      assert.deepEqual(JSON.parse(updated), { name: '' });
      await s.open('locales/modules/features/zh/user.json', updated);
      assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
    });
  }
});

test('deeply overlapping roots retain an ancestor locale that has its own file', async (t) => {
  const source = "t('name')";
  const s = await startServer(t, {
    'locales/modules/features/en/index.json': '{"name":"User"}',
    'locales/modules/index.json': '{}',
    'src/app.ts': source,
  }, { localeDirs: ['locales', 'locales/modules/features'] });
  await s.open('src/app.ts', source);
  const diagnostics = s.diagnostics.get(s.uri('src/app.ts'));
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].data.missingLocales, ['modules']);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const [edit] = documentEdits(action);
  assert.equal(edit.textDocument.uri, s.uri('locales/modules/index.json'));
  assert.deepEqual(JSON.parse(applyText('{}', edit)), { name: '' });
});

test('fileless intermediate directories stay watched as locales appear and disappear', { timeout: 45000 }, async (t) => {
  const nestedRoot = 'locales/modules/features';
  for (const localeDirs of [['locales', nestedRoot], [nestedRoot, 'locales']]) {
    await t.test(localeDirs.join(', '), { timeout: 20000 }, async (t) => {
      const source = "t('user.name')\nt('pending.deep.title')";
      const s = await startServer(t, {
        [nestedRoot + '/en/user.json']: '{"name":"User"}',
        [nestedRoot + '/en/pending/deep/index.json']: '{"title":"Existing"}',
        'locales/modules/pending/deep/.keep': '',
        'src/app.ts': source,
      }, { localeDirs });
      // Wait for the initialized reload to install watchers before touching disk.
      await s.ready;
      await s.open('src/app.ts', source);
      assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
      const file = path.join(s.root, 'locales/modules/pending/deep/index.json');
      const titlePosition = { line: 1, character: 4 };
      for (const title of ['Watched', 'Watched again']) {
        const appeared = s.nextDiagnostics('src/app.ts', (items) => items.length === 1
          && items[0].data.key === 'user.name' && items[0].data.missingLocales.join(',') === 'modules', 5000);
        await fs.writeFile(file, JSON.stringify({ title }));
        await appeared;
        const hover = await s.call('textDocument/hover', 'src/app.ts', { position: titlePosition });
        assert.ok(hover.contents.value.includes(`| modules | ${title} |`));
        const disappeared = s.nextDiagnostics('src/app.ts', (items) => items.length === 0, 5000);
        await fs.unlink(file);
        await disappeared;
        const after = await s.call('textDocument/hover', 'src/app.ts', { position: titlePosition });
        assert.doesNotMatch(after.contents.value, /\| modules \|/);
      }
    });
  }
});

test('extract action writes the default locale and rewrites the template', async (t) => {
  const s = await startServer(t, { 'locales/en.json': '{\n  "known": "Known"\n}\n' }, { rawTextDiagnostics: true });
  const source = '<template><p>Hello world</p><b>{{ $t(\'known\') }}</b></template>';
  const pending = s.nextDiagnostics('src/Home.vue', (items) => items.some((item) => item.code === 'raw-text'));
  await s.open('src/Home.vue', source);
  await pending;
  const all = await s.actions('src/Home.vue');
  const action = all.find((a) => a.title.startsWith('Extract'));
  assert.equal(action.title, 'Extract to i18n key "Home.hello_world"');
  const [locale, doc] = documentEdits(action);
  assert.equal(applyText('{\n  "known": "Known"\n}\n', locale), '{\n  "known": "Known",\n  "Home": {\n    "hello_world": "Hello world"\n  }\n}\n');
  assert.equal(applyText(source, doc), '<template><p>{{ $t(\'Home.hello_world\') }}</p><b>{{ $t(\'known\') }}</b></template>');
  const inline = await s.call('textDocument/codeAction', 'src/Home.vue', { range: { start: { line: 0, character: 38 }, end: { line: 0, character: 38 } }, context: { diagnostics: [] } });
  assert.deepEqual(inline.map((a) => a.title), ['Inline i18n key "known" as en']);
  assert.equal(applyText(source, documentEdits(inline[0])[0]), '<template><p>Hello world</p><b>Known</b></template>');
});

test('inline attribute action preserves unsaved locale text through HTML and JS escaping', async (t) => {
  const source = `<template><img :alt="t('greet')" data-keep="unchanged"></template>`;
  const diskLocale = '{"greet":"Disk"}';
  const value = 'Hello {name}, say "hi" &quot; \\path\nNext line';
  const s = await startServer(t, { 'locales/en.json': diskLocale, 'src/App.vue': source });
  await s.open('locales/en.json', JSON.stringify({ greet: value }), 4);
  await s.open('src/App.vue', source, 7);
  const caret = { line: 0, character: source.indexOf('greet') + 1 };
  const actions = await s.call('textDocument/codeAction', 'src/App.vue', {
    range: { start: caret, end: caret }, context: { diagnostics: [] },
  });
  const action = actions.find((item) => item.title === 'Inline i18n key "greet" as en');
  assert.ok(action);
  const edits = documentEdits(action);
  assert.equal(edits.length, 1, 'inline edits only the source, not the locale');
  assert.deepEqual(edits[0].textDocument, { uri: s.uri('src/App.vue'), version: 7 });
  const updated = applyText(source, edits[0]);
  const image = DomUtils.findOne((node) => node.name === 'img', parseDocument(updated).children, true);
  assert.deepEqual(Object.keys(image.attribs).sort(), [':alt', 'data-keep']);
  assert.equal(image.attribs['data-keep'], 'unchanged');
  assert.equal(vm.runInNewContext(image.attribs[':alt'], {}, { timeout: 1000 }), value);
  assert.equal(await fs.readFile(path.join(s.root, 'locales/en.json'), 'utf8'), diskLocale);
});

test('an Extract exception preserves other code actions and subsequent language requests', { timeout: 15000 }, async (t) => {
  const locale = '{"known":"Known"}';
  const source = '<template>' + '<div>'.repeat(6000) + 'Hello World' + '</div>'.repeat(6000) + "{{ t('missing') }}</template>";
  const s = await startServer(t, { 'locales/en.json': locale, 'Deep.vue': source, 'other.ts': "t('known')" });
  await s.open('Deep.vue', source);
  const actions = await s.actions('Deep.vue');
  assert.ok(actions.some((a) => a.title.startsWith('Create i18n key')));
  assert.equal(actions.some((a) => a.title.startsWith('Extract')), false);
  assert.ok(s.logs.some((log) => log.type === 1 && log.message.includes('Extract') && log.message.includes(s.uri('Deep.vue'))));
  await s.open('other.ts', "t('known')");
  assert.match((await s.sync('other.ts')).contents.value, /Known/);
  assert.equal((await s.call('textDocument/definition', 'other.ts', { position }))[0].uri, s.uri('locales/en.json'));
  assert.equal((await s.call('textDocument/inlayHint', 'other.ts', { range }))[0].label, 'Known');
  assert.equal(await fs.readFile(path.join(s.root, 'locales/en.json'), 'utf8'), locale);
  assert.equal(await fs.readFile(path.join(s.root, 'Deep.vue'), 'utf8'), source);
});

test('Extract refuses malformed locale text and recovers without changing any disk files', async (t) => {
  const source = '<template><p>Hello world</p></template>';
  const s = await startServer(t, { 'locales/en.json': '{}', 'Home.vue': source, 'other.ts': "t('known')" });
  await s.open('Home.vue', source, 3);
  await s.open('locales/en.json', '{"broken":', 4);
  const caret = { line: 0, character: source.indexOf('Hello') + 1 };
  const getActions = () => s.call('textDocument/codeAction', 'Home.vue', { range: { start: caret, end: caret }, context: { diagnostics: [] } });
  assert.deepEqual(await getActions(), []);
  await s.change('locales/en.json', '{"known":"Recovered","unsaved":"Keep"}', 5);
  const action = (await getActions()).find((a) => a.title.startsWith('Extract'));
  assert.ok(action);
  const edits = documentEdits(action);
  assert.deepEqual(edits.map((e) => e.textDocument.version), [5, 3]);
  const localeEdit = edits.find((e) => e.textDocument.uri === s.uri('locales/en.json'));
  assert.deepEqual(JSON.parse(applyText('{"known":"Recovered","unsaved":"Keep"}', localeEdit)), {
    known: 'Recovered', unsaved: 'Keep', Home: { hello_world: 'Hello world' },
  });
  await s.open('other.ts', "t('known')");
  assert.match((await s.sync('other.ts')).contents.value, /Recovered/);
  assert.equal(await fs.readFile(path.join(s.root, 'locales/en.json'), 'utf8'), '{}');
  assert.equal(await fs.readFile(path.join(s.root, 'Home.vue'), 'utf8'), source);
});
