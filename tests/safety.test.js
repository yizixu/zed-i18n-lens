import test from 'node:test';
import assert from 'node:assert/strict';
import { extractI18nKeys, getCompletionPrefix, getDiagnostics, findCodeKeyRanges, getInlayHints, findJsonKeyLocation, insertNestedJsonKey, localeKeyAtPosition, findLocaleKeyTarget } from '../server/core.js';

const prefix = (text) => getCompletionPrefix(text, { line: text.split('\n').length - 1, character: text.split('\n').at(-1).length });

test('recognition skips comments, ordinary strings and dynamic first arguments', () => {
  const source = [
    '// t("comment")',
    '/* $t("block") */',
    'const note = "t(\'string\')";',
    'const raw = `t("raw")`;',
    '<!-- <Trans i18nKey="html.comment" /> -->',
    't("prefix." + suffix);',
    'formatMessage({ id: "prefix." + suffix });',
    'not$t("lookalike");',
    't("real")',
  ].join('\n');
  assert.deepEqual(extractI18nKeys(source).map((item) => item.key), ['real']);
});

test('recognition retains Vue attributes, JSX and template-literal expressions', () => {
  const source = [
    '<button :title="$t(\'bound\')" @click="t(\'click\')" v-t="\'directive\'">{{ t("vue") }}</button>',
    '<i18n-t keypath="key" /><Trans i18nKey="react" />',
    '<span>{t("jsx")}</span>',
    'const text = `raw t("ignored") ${t("interpolated")} ${`nested ${t("nested")}`}`;',
  ].join('\n');
  const items = extractI18nKeys(source);
  assert.deepEqual(items.map((item) => item.key), ['bound', 'click', 'directive', 'vue', 'key', 'react', 'jsx', 'interpolated', 'nested']);
  for (const item of items) assert.equal(source.slice(item.startOffset, item.endOffset), item.key);
});

test('recognition skips lookalike calls in static HTML and JSX attributes', () => {
  const source = `<a title="$t('nav.docs')" alt="t('site.title')" data-tip="i18n.t('help')">$t('site.footer')</a>`;
  assert.deepEqual(extractI18nKeys(source).map((item) => item.key), ['site.footer']);
  assert.deepEqual(extractI18nKeys(`<img title="t('literal')" />`).map((item) => item.key), []);
  assert.deepEqual(extractI18nKeys(source, { includeStaticAttrCalls: true }).map((item) => item.key), ['nav.docs', 'site.title', 'help', 'site.footer']);
});

test('diagnostics, refs and inlays ignore static attribute lookalike calls', () => {
  const text = `<img title="t('missing')" alt="t('also')">`;
  const locales = { en: { path: 'en.json', flat: { missing: 'M', also: 'A' } } };
  assert.deepEqual(getDiagnostics(text, { en: { path: 'en.json', flat: { real: 'R' } } }), []);
  assert.deepEqual(findCodeKeyRanges(text, 'missing'), []);
  assert.deepEqual(getInlayHints(text, null, locales, 'en'), []);
  const bound = `<div :title="t('missing')"></div>`;
  assert.equal(getDiagnostics(bound, { en: { path: 'en.json', flat: { real: 'R' } } })[0].data.key, 'missing');
});

test('completion distinguishes empty i18n strings from non-i18n contexts', () => {
  assert.equal(prefix("t('"), '');
  assert.equal(prefix("const x = 1;"), undefined);
  assert.equal(prefix("// t('ignored"), undefined);
  assert.equal(prefix('const text = "t(\'ignored'), undefined);
  assert.equal(prefix("not$t('ignored"), undefined);
  assert.equal(prefix("t('prefix.' + suffix"), undefined);
  assert.equal(prefix('<button :title="$t(\'common.'), 'common.');
  assert.equal(prefix('<a title="t(\'ignored'), undefined);
  assert.equal(prefix('<div v-t="{ path: \'common.'), 'common.');
  assert.equal(prefix('const text = `raw ${t("common.'), 'common.');
});

test('JSON lookup and insertion respect sibling paths, repeated segments and arrays', () => {
  const text = '{"a":{"b":{"c":"Inner"}},"b":{"c":"Outer"},"same":{"same":"Repeated"},"list":[{"c":"Array"}]}';
  assert.deepEqual(findJsonKeyLocation(text, 'b.c'), { line: 0, character: text.indexOf('"c":"Outer"') });
  assert.deepEqual(findJsonKeyLocation(text, 'same.same'), { line: 0, character: text.indexOf('"same":"Repeated"') });
  assert.equal(findJsonKeyLocation(text, 'list.c'), undefined);
  assert.equal(findJsonKeyLocation(text, 'a.c'), undefined);
  const updated = JSON.parse(insertNestedJsonKey(text, 'b.d', 'New'));
  assert.deepEqual(updated.a, { b: { c: 'Inner' } });
  assert.deepEqual(updated.b, { c: 'Outer', d: 'New' });
});

test('JSON edits refuse scalar, null, array, duplicate and overlapping path conflicts', () => {
  assert.equal(insertNestedJsonKey('{"a":1}', 'a.b'), undefined);
  assert.equal(insertNestedJsonKey('{"a":null}', 'a.b'), undefined);
  assert.equal(insertNestedJsonKey('{"a":[]}', 'a.b'), undefined);
  assert.equal(insertNestedJsonKey('{"a":{},"a":{}}', 'a.b'), undefined);
  assert.equal(insertNestedJsonKey('{"a.b":{},"a":{"b":{}}}', 'a.b.c'), undefined);
  assert.equal(insertNestedJsonKey('{"a.b":"Keep"}', 'a.b'), undefined);
  assert.equal(findJsonKeyLocation('{"a.b":1,"a":{"b":2}}', 'a.b'), undefined);
});

test('JSON lookup decodes escaped names and preserves the complete dotted key selection', () => {
  const text = '{"order.pay_now":"Pay","escaped\\u002ekey":"Escaped"}';
  const locale = {
    path: '/repo/en.json', files: ['/repo/en.json'],
    flat: { 'order.pay_now': 'Pay', 'escaped.key': 'Escaped' },
    keyFiles: { 'order.pay_now': '/repo/en.json', 'escaped.key': '/repo/en.json' },
  };
  const target = findLocaleKeyTarget(locale, 'escaped.key', { '/repo/en.json': text });
  assert.equal(text.slice(target.range.start.character, target.range.end.character), '"escaped\\u002ekey"');
  assert.equal(localeKeyAtPosition(locale, locale.path, text, { line: 0, character: text.indexOf('now') }), 'order.pay_now');
  assert.equal(localeKeyAtPosition(locale, locale.path, text, { line: 0, character: text.indexOf('Pay') }), undefined);
});

test('JSON insertion preserves CRLF and does not follow inherited properties', () => {
  const text = '{\r\n\t"keep": "Unchanged"\r\n}\r\n';
  const output = insertNestedJsonKey(text, '__proto__.label', 'Safe');
  assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(output.includes('\t"keep": "Unchanged"'));
  const parsed = JSON.parse(output);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.deepEqual(parsed.__proto__, { label: 'Safe' });
  assert.equal(Object.hasOwn(Object.prototype, 'label'), false);
});
