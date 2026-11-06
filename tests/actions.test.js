import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseDocument, DomUtils } from 'htmlparser2';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getExtractCodeActions, getInlineCodeActions, getRawTextDiagnostics } from '../server/core.js';

function apply(text, edit) {
  return TextDocument.applyEdits(TextDocument.create('file:///x', 'vue', 0, text), [edit]);
}

function extract(text, flat = {}, range) {
  return getExtractCodeActions(text, 'vue', '/src/components/LoginForm.vue', range, range ? [] : getRawTextDiagnostics(text, 'vue', true), flat);
}

test('extract template text and attributes to a file-stem key', () => {
  const text = '<template><p title="Sign in now">Hello world</p></template>';
  const actions = extract(text);
  assert.deepEqual(actions.map((a) => [a.key, a.value]), [['LoginForm.sign_in_now', 'Sign in now'], ['LoginForm.hello_world', 'Hello world']]);
  assert.equal(apply(text, actions[0].edit), `<template><p :title="$t('LoginForm.sign_in_now')">Hello world</p></template>`);
  assert.equal(apply(text, actions[1].edit), `<template><p title="Sign in now">{{ $t('LoginForm.hello_world') }}</p></template>`);
});

test('extract rewrites bound string literal attributes', () => {
  const text = `<template><input :placeholder="'Your name'"></template>`;
  const [action] = extract(text);
  assert.equal(apply(text, action.edit), `<template><input :placeholder="$t('LoginForm.your_name')"></template>`);
});

test('extract rewrites static attributes with surrounding whitespace', () => {
  const text = '<template><input title = "  Hello world  "></template>';
  const [action] = extract(text);
  assert.equal(action.value, 'Hello world');
  assert.equal(apply(text, action.edit), `<template><input :title="$t('LoginForm.hello_world')"></template>`);
});

test('extract rewrites unquoted attributes to a bound $t call', () => {
  const text = '<template><input title=Hello></template>';
  const [action] = extract(text);
  assert.equal(action.value, 'Hello');
  assert.equal(apply(text, action.edit), `<template><input :title="$t('LoginForm.hello')"></template>`);
  const html = '<input title=Save>';
  const [htmlAction] = getExtractCodeActions(html, 'html', '/page.html', undefined, getRawTextDiagnostics(html, 'html', true), {});
  assert.equal(apply(html, htmlAction.edit), `<input :title="$t('page.save')">`);
});

test('extract rewrites padded bound string literal attributes', () => {
  const text = `<template><input :placeholder=" 'Enter name' "></template>`;
  const [action] = extract(text);
  assert.equal(action.value, 'Enter name');
  assert.equal(apply(text, action.edit), `<template><input :placeholder="$t('LoginForm.enter_name')"></template>`);
});

test('extract always creates a file-stem key (no reuse) and avoids collisions', () => {
  const text = '<template><b>Hello world</b></template>';
  assert.equal(extract(text, { 'common.hello': 'Hello world' })[0].key, 'LoginForm.hello_world');
  assert.equal(extract(text, { 'LoginForm.hello_world': 'Other' })[0].key, 'LoginForm.hello_world_2');
});

test('extract skips interpolation/entities and hashes non-Latin text', () => {
  assert.deepEqual(extract('<template><p>Tom &amp; Jerry</p></template>'), []);
  const parts = extract('<template><p>Hi {{ name }} there friend</p></template>');
  assert.deepEqual(parts.map((a) => a.value), ['there friend']);
  assert.match(extract('<template><p>你好世界</p></template>')[0].key, /^LoginForm\.text_[0-9a-f]+$/);
});

test('extract accepts lowercase, all-caps and short words', () => {
  for (const word of ['save', 'OK', 'Go', 'userName']) {
    const text = `<template><p>${word}</p></template>`;
    const p = { line: 0, character: text.indexOf(word) + 1 };
    assert.equal(extract(text, {}, { start: p, end: p })[0]?.value, word, word);
  }
  const url = '<template><p>https://example.com</p></template>';
  const q = { line: 0, character: 16 };
  assert.deepEqual(extract(url, {}, { start: q, end: q }), []);
});

test('extract offers selected raw text even without diagnostics', () => {
  const text = '<template><p>Hello world</p></template>';
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } };
  assert.equal(getExtractCodeActions(text, 'vue', '/a/App.vue', range, [], {})[0].key, 'App.hello_world');
});

const locales = { en: { flat: { greet: 'Say "hi" <now>', it: "it's" } }, zh: { flat: { greet: '你好' } } };
const at = (text, needle) => { const p = { line: 0, character: text.indexOf(needle) + 1 }; return { start: p, end: p }; };

test('inline template interpolation as plain text per locale', () => {
  const text = `<template><p>{{ $t('greet') }}</p></template>`;
  const actions = getInlineCodeActions(text, at(text, '$t'), locales);
  assert.deepEqual(actions.map((a) => a.title), ['Inline i18n key "greet" as en', 'Inline i18n key "greet" as zh']);
  assert.equal(apply(text, actions[0].edit), '<template><p>Say &quot;hi&quot; &lt;now&gt;</p></template>');
  assert.equal(apply(text, actions[1].edit), '<template><p>你好</p></template>');
});

test('inline bound attribute becomes a plain attribute', () => {
  const text = `<template><img :alt="$t('greet')"></template>`;
  const [en] = getInlineCodeActions(text, at(text, 'greet'), locales);
  assert.equal(apply(text, en.edit), '<template><img alt="Say &quot;hi&quot; &lt;now&gt;"></template>');
});

test('inline JS call becomes a quoted string literal', () => {
  const text = "const a = t('it');";
  const actions = getInlineCodeActions(text, at(text, 't('), locales);
  assert.equal(actions.length, 1);
  assert.equal(apply(text, actions[0].edit), "const a = 'it\\'s';");
});

test('inline JS does not treat tags inside string literals as HTML context', () => {
  const text = "const html = '<p>'; const label = t('greet');";
  const [en] = getInlineCodeActions(text, at(text, "t('"), { en: { flat: { greet: 'Hello' } } });
  assert.equal(apply(text, en.edit), "const html = '<p>'; const label = 'Hello';");
});

test('inline JS inside HTML script breaks </script> in the generated string', () => {
  const text = `<script>const label = t('greet');</script>`;
  const [en] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: 'Hello</script><img>' } } });
  assert.equal(apply(text, en.edit), `<script>const label = 'Hello<\\/script><img>';</script>`);
  const mixed = `<script>const label = t('greet');</script>`;
  const [upper] = getInlineCodeActions(mixed, at(mixed, 't('), { en: { flat: { greet: '</SCRIPT>' } } });
  assert.equal(apply(mixed, upper.edit), `<script>const label = '<\\/SCRIPT>';</script>`);
});

test('inline skips calls with params or outside a call', () => {
  const text = "t('greet', { n: 1 }); x";
  assert.deepEqual(getInlineCodeActions(text, at(text, 'greet'), locales), []);
  assert.deepEqual(getInlineCodeActions(text, { start: { line: 0, character: text.length } }, locales), []);
});

test('inline skips partial attribute expressions', () => {
  const text = `<template><div :title="$t('greet') + ' suffix'"></div></template>`;
  assert.deepEqual(getInlineCodeActions(text, at(text, 'greet'), locales), []);
});

test('inline works for t() inside element that has unrelated attributes', () => {
  const text = `<template><h2 class="x">{{ t('greet') }}</h2></template>`;
  const actions = getInlineCodeActions(text, at(text, 't('), locales);
  assert.equal(actions.length, 2);
  assert.match(actions[0].title, /Inline i18n key "greet"/);
});

test('inline escapes quotes when rewriting bound attribute values', () => {
  const text = `<template><div :aria-label="$t('greet')"></div></template>`;
  const [action] = getInlineCodeActions(text, at(text, 'greet'), locales);
  assert.equal(apply(text, action.edit), '<template><div aria-label="Say &quot;hi&quot; &lt;now&gt;"></div></template>');
});

test('inline HTML text node replaces the call with raw locale text', () => {
  const text = `<p>$t('greet')</p>`;
  const actions = getInlineCodeActions(text, at(text, '$t'), locales);
  assert.equal(apply(text, actions[0].edit), '<p>Say &quot;hi&quot; &lt;now&gt;</p>');
  assert.equal(apply(text, actions[1].edit), '<p>你好</p>');
  const mixed = `<p>Hello $t('it')!</p>`;
  const [en] = getInlineCodeActions(mixed, at(mixed, '$t'), { en: { flat: { it: 'LiG' } } });
  assert.equal(apply(mixed, en.edit), '<p>Hello LiG!</p>');
});

test('HTML attribute $t is inlined, not extracted', () => {
  const text = `<a title="$t('greet')">x</a>`;
  const range = at(text, '$t');
  assert.deepEqual(getExtractCodeActions(text, 'html', '/page.html', range, [], {}), []);
  const [en] = getInlineCodeActions(text, range, locales);
  assert.equal(apply(text, en.edit), '<a title="Say &quot;hi&quot; &lt;now&gt;">x</a>');
  const tc = `<img alt="$tc('greet')">`;
  assert.equal(apply(tc, getInlineCodeActions(tc, at(tc, '$tc'), locales)[0].edit), '<img alt="Say &quot;hi&quot; &lt;now&gt;">');
  const i18nT = `<img alt="i18n.t('greet')">`;
  assert.equal(apply(i18nT, getInlineCodeActions(i18nT, at(i18nT, 'i18n.t'), locales)[0].edit), '<img alt="Say &quot;hi&quot; &lt;now&gt;">');
  const jsx = `<img title="t('greet')" />`;
  assert.equal(apply(jsx, getInlineCodeActions(jsx, at(jsx, 't('), locales)[0].edit), '<img title="Say &quot;hi&quot; &lt;now&gt;" />');
});

test('inline skips partial HTML attribute expressions', () => {
  const text = `<a title="$t('greet') + 'x'">x</a>`;
  assert.deepEqual(getInlineCodeActions(text, at(text, 'greet'), locales), []);
});

test('extract still rewrites ordinary HTML attributes', () => {
  const text = '<p title="Hello world">Save</p>';
  const actions = getExtractCodeActions(text, 'html', '/page.html', undefined, getRawTextDiagnostics(text, 'html', true), {});
  assert.deepEqual(actions.map((a) => a.value).sort(), ['Hello world', 'Save']);
});

test('inline JSX text child unwraps braces', () => {
  const text = `<h1>{t('greet')}</h1>`;
  const [en] = getInlineCodeActions(text, at(text, 't('), locales);
  assert.equal(apply(text, en.edit), '<h1>Say &quot;hi&quot; &lt;now&gt;</h1>');
  const padded = `<h1>{ t('it') }</h1>`;
  const [it] = getInlineCodeActions(padded, at(padded, 't('), { en: { flat: { it: 'LiG' } } });
  assert.equal(apply(padded, it.edit), '<h1>LiG</h1>');
});

test('inline JSX text child keeps braces when the translation contains {', () => {
  const text = `<p>{t('greet')}</p>`;
  const [expr] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: '{++counter}' } } });
  assert.equal(apply(text, expr.edit), `<p>{'{++counter}'}</p>`);
  const [interp] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: 'Hello {name}' } } });
  assert.equal(apply(text, interp.edit), `<p>{'Hello {name}'}</p>`);
});

test('inline Vue interpolation keeps mustache when the translation contains {', () => {
  const text = `<template><p>{{ t('greet') }}</p></template>`;
  const [expr] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: '{++counter}' } } });
  assert.equal(apply(text, expr.edit), `<template><p>{{ '{++counter}' }}</p></template>`);
  const [interp] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: 'Hello {name}' } } });
  assert.equal(apply(text, interp.edit), `<template><p>{{ 'Hello {name}' }}</p></template>`);
  const [mustache] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { greet: '{{ test }}' } } });
  assert.equal(apply(text, mustache.edit), `<template><p>{{ '{{ test }}' }}</p></template>`);
});

test('inline Vue bound attribute keeps a string when the translation contains {', () => {
  const text = `<template><img :alt="$t('greet')"></template>`;
  const [en] = getInlineCodeActions(text, at(text, 'greet'), { en: { flat: { greet: '{{ test }}' } } });
  assert.equal(apply(text, en.edit), `<template><img :alt="'{{ test }}'"></template>`);
});

test('inline bound attributes round-trip braces, quotes and entities through HTML and JS', () => {
  const attributes = [
    `:alt="t('greet')"`,
    `:alt='t("greet")'`,
    `v-bind:alt="t('greet')"`,
    `v-bind:alt='t("greet")'`,
  ];
  const values = [
    'Hello {name}, say "hi"',
    "It's {name}",
    '{++counter} &quot; &#39; & <tag> "both\'quotes" \\path\r\nNext line',
  ];
  for (const attribute of attributes) {
    const text = `<template><img ${attribute} data-keep="unchanged"></template>`;
    for (const value of values) {
      const [action] = getInlineCodeActions(text, at(text, 'greet'), { en: { flat: { greet: value } } });
      assert.ok(action, attribute);
      const updated = apply(text, action.edit);
      const image = DomUtils.findOne((node) => node.name === 'img', parseDocument(updated).children, true);
      assert.deepEqual(Object.keys(image.attribs).sort(), [':alt', 'data-keep'], updated);
      assert.equal(image.attribs['data-keep'], 'unchanged');
      const context = { counter: 0 };
      assert.equal(vm.runInNewContext(image.attribs[':alt'], context, { timeout: 1000 }), value, updated);
      assert.equal(context.counter, 0, 'translation stays text rather than executing an expression');
    }
  }
});

test('inline JSX attribute unwraps braces to a quoted attribute', () => {
  const text = `<img title={t('greet')} />`;
  const [en] = getInlineCodeActions(text, at(text, 't('), locales);
  assert.equal(apply(text, en.edit), '<img title="Say &quot;hi&quot; &lt;now&gt;" />');
});

test('inline JSX keeps quotes inside mixed brace expressions', () => {
  const text = `<h1>{t('it') + extra}</h1>`;
  const [en] = getInlineCodeActions(text, at(text, 't('), { en: { flat: { it: "it's" } } });
  assert.equal(apply(text, en.edit), `<h1>{'it\\'s' + extra}</h1>`);
});

test('extract key prefix comes from the nearest ancestor with keys', () => {
  const text = `<template><div><p>{{ t('header.title') }}</p><section class="s"><h2>{{ t('palette.sections.syntaxTitle') }}</h2><p>Syntax</p></section></div></template>`;
  const [action] = extract(text);
  assert.equal(action.key, 'palette.sections.syntax');
  assert.equal(action.keySource, 'ancestor');
  assert.equal(action.title, 'Extract to i18n key "palette.sections.syntax"');
});

test('extract key prefix uses ancestor common prefix and descends by id anchor', () => {
  const text = `<template><section id="syntax"><h2>{{ $t('palette.intro.a') }}</h2><h3 :title="$t('palette.other.b')"></h3><p>Keywords here</p></section></template>`;
  assert.equal(extract(text)[0].key, 'palette.keywords_here');
  assert.equal(extract(text, { 'palette.syntax.x': 'X' })[0].key, 'palette.syntax.keywords_here');
});

test('extract key prefix falls back to file-level common prefix', () => {
  const text = `<template><header>{{ t('app.nav.home') }}</header><main><img src="a.png"><p>Welcome back</p></main></template><script>t('app.nav.about')</script>`;
  const [action] = extract(text);
  assert.equal(action.key, 'app.nav.welcome_back');
  assert.equal(action.keySource, 'file');
});

test('extract key prefix falls back to file stem when no keys exist', () => {
  const [action] = extract('<template><p>Hello world</p></template>');
  assert.equal(action.key, 'LoginForm.hello_world');
  assert.equal(action.keySource, 'filename');
});

test('extract key prefix excludes the last segment; single-segment keys give no prefix', () => {
  assert.equal(extract(`<template><div>{{ t('save') }}<p>Hello world</p></div></template>`)[0].keySource, 'filename');
  assert.equal(extract(`<template><div>{{ t('a.b') }}<p>Hello world</p></div></template>`)[0].key, 'a.hello_world');
});

test('extract derived key avoids collisions', () => {
  const text = `<template><section><h2>{{ t('palette.sections.syntaxTitle') }}</h2><p>Syntax</p></section></template>`;
  assert.equal(extract(text, { 'palette.sections.syntax': 'S' })[0].key, 'palette.sections.syntax_2');
  assert.equal(extract(text, { 'palette.sections.syntax.x': 'S' })[0].key, 'palette.sections.syntax_2');
});

test('extract bounds dense collision searches without rescanning all locale keys', { timeout: 2000 }, () => {
  const text = '<template><p>Hello world</p></template>';
  const flat = Object.fromEntries(Array.from({ length: 100000 }, (_, i) => [`other.key${i}`, 'Other']));
  flat['LoginForm.hello_world'] = 'Taken';
  for (let i = 2; i <= 10000; i++) flat[`LoginForm.hello_world_${i}`] = 'Taken';
  assert.deepEqual(extract(text, flat), []);
  delete flat['LoginForm.hello_world_9999'];
  flat['LoginForm.hello_world_9999.child'] = 'Taken branch';
  delete flat['LoginForm.hello_world_10000'];
  assert.equal(extract(text, flat)[0].key, 'LoginForm.hello_world_10000');
});

test('extract uses an alt key when a parent locale key is a leaf', () => {
  const text = '<template><p>Hello world</p></template>';
  const raw = getRawTextDiagnostics(text, 'vue', true);
  assert.equal(getExtractCodeActions(text, 'vue', '/src/Home.vue', undefined, raw, { Home: '首页' })[0].key, 'hello_world');
  assert.equal(getExtractCodeActions(text, 'vue', '/src/hello.vue', undefined, raw, { hello: 'x' })[0].key, 'hello_world');
  assert.equal(getExtractCodeActions(text, 'vue', '/src/Home.vue', undefined, raw, { Home: '首页', hello_world: 'other' })[0].key, 'hello_world_2');

  const nested = `<template><section><h2>{{ t('palette.sections.syntaxTitle') }}</h2><p>Syntax</p></section></template>`;
  assert.equal(extract(nested, { 'palette.sections': 'S' })[0].key, 'palette.syntax');

  const deep = `<template><section><h2>{{ t('a.b.c.existing') }}</h2><p>Hello world</p></section></template>`;
  assert.equal(extract(deep, { 'a.b.c.existing': 'x' })[0].key, 'a.b.c.hello_world');
  assert.equal(extract(deep, { 'a.b.c.existing': 'x', 'a.b.c.hello_world': 'y' })[0].key, 'a.b.c.hello_world_2');
  assert.equal(extract(deep, { 'a.b': 'leaf' })[0].key, 'a.c.hello_world');
});
