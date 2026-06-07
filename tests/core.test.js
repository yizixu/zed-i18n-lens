import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenLocale,
  extractI18nKeys,
  getValueByKey,
  buildHoverMarkdown,
  getDiagnostics,
  getCompletions,
  getInlayHints,
  normalizeI18nLensConfig,
  didWatchedFileChange,
  resolvePreferredLocale,
  getDefinitionLocaleOrder,
  collectLocaleWatchPaths,
  findJsonKeyLocation,
} from '../server/core.js';

test('flattenLocale flattens nested locale objects', () => {
  assert.deepEqual(flattenLocale({ order: { pay_now: '立即支付' }, common: { ok: '确定' } }), {
    'order.pay_now': '立即支付',
    'common.ok': '确定',
  });
});

test('extractI18nKeys finds Vue and TS i18n calls with ranges', () => {
  const text = '<button>{{ $t("order.pay_now") }}</button>\nconst x = t(\'common.ok\')\n<div v-t="\'user.name\'"></div>';
  const keys = extractI18nKeys(text).map((x) => x.key);
  assert.deepEqual(keys, ['order.pay_now', 'common.ok', 'user.name']);
});

test('hover markdown shows all locale values and missing locales', () => {
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } },
    'en-US': { path: 'en-US.json', flat: { 'order.pay_now': 'Pay Now' } },
    'ja-JP': { path: 'ja-JP.json', flat: {} },
  };
  const md = buildHoverMarkdown('order.pay_now', locales);
  assert.match(md, /zh-CN.*立即支付/);
  assert.match(md, /en-US.*Pay Now/);
  assert.match(md, /ja-JP.*Missing/);
});

test('hover markdown escapes pipe characters so the table is not broken', () => {
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.choice': '是 | 否' } } };
  const md = buildHoverMarkdown('order.choice', locales);
  assert.match(md, /是 \\\| 否/);
});

test('diagnostics reports only keys missing from all locales as errors', () => {
  const text = 't("order.pay_now"); t("order.missing")';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } } };
  const diagnostics = getDiagnostics(text, locales);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 1);
  assert.equal(diagnostics[0].message, 'Missing i18n key: order.missing');
  assert.deepEqual(diagnostics[0].data, { key: 'order.missing', missingLocales: ['zh-CN'], missingInAllLocales: true });
});

test('diagnostics reports keys missing from some locales as warnings', () => {
  const text = 't("order.pay_now")';
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } },
    'en-US': { path: 'en-US.json', flat: {} },
    'ja-JP': { path: 'ja-JP.json', flat: {} },
  };
  const diagnostics = getDiagnostics(text, locales);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 2);
  assert.equal(diagnostics[0].message, 'Missing i18n key "order.pay_now" in locales: en-US, ja-JP');
  assert.deepEqual(diagnostics[0].data, { key: 'order.pay_now', missingLocales: ['en-US', 'ja-JP'], missingInAllLocales: false });
});

test('diagnostics does not report keys present in every locale', () => {
  const text = 't("order.pay_now")';
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } },
    'en-US': { path: 'en-US.json', flat: { 'order.pay_now': 'Pay Now' } },
  };
  assert.deepEqual(getDiagnostics(text, locales), []);
});

test('diagnostics does not report when no locale files are loaded', () => {
  assert.deepEqual(getDiagnostics('t("order.pay_now")', {}), []);
});

test('completion returns keys matching prefix with default locale detail', () => {
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付', 'order.cancel': '取消订单', 'common.ok': '确定' } } };
  const items = getCompletions('order.', locales, 'zh-CN');
  assert.deepEqual(items.map((x) => x.label), ['order.cancel', 'order.pay_now']);
  assert.equal(items[0].detail, '取消订单');
});



test('completion uses configured default locale when multiple locales exist', () => {
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } },
    'en-US': { path: 'en-US.json', flat: { 'order.pay_now': 'Pay Now' } },
  };
  const items = getCompletions('order.', locales, 'en-US');
  assert.equal(items[0].detail, 'Pay Now');
});

test('inlay hints use configured default locale when multiple locales exist', () => {
  const text = 't("order.pay_now")';
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } },
    'en-US': { path: 'en-US.json', flat: { 'order.pay_now': 'Pay Now' } },
  };
  const hints = getInlayHints(text, { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }, locales, 'en-US');
  assert.equal(hints[0].label, 'Pay Now');
});

test('default locale matching accepts language aliases and underscore separators', () => {
  const locales = {
    'zh-CN': { path: 'zh-CN.json', flat: { ok: '确定' } },
    en_US: { path: 'en_US.json', flat: { ok: 'OK' } },
  };
  assert.equal(resolvePreferredLocale(locales, 'en-US').flat.ok, 'OK');
  assert.equal(resolvePreferredLocale(locales, 'en').flat.ok, 'OK');
});



test('definition locale order prefers configured default locale aliases', () => {
  const locales = {
    'en-US': { path: '/repo/src/locales/en-US.json', flat: { ok: 'OK' }, files: ['/repo/src/locales/en-US.json'] },
    'zh-CN': { path: '/repo/src/locales/zh-CN.json', flat: { ok: '确定' }, files: ['/repo/src/locales/zh-CN.json'] },
  };
  const ordered = getDefinitionLocaleOrder(locales, 'ZH');
  assert.deepEqual(ordered.map((locale) => locale.path), [
    '/repo/src/locales/zh-CN.json',
    '/repo/src/locales/en-US.json',
  ]);
});

test('findJsonKeyLocation returns line/character for nested JSON key', () => {
  const json = '{\n  "order": {\n    "pay_now": "立即支付"\n  }\n}\n';
  const loc = findJsonKeyLocation(json, 'order.pay_now');
  assert.deepEqual(loc, { line: 2, character: 4 });
});

test('findJsonKeyLocation tolerates whitespace between key and colon', () => {
  const json = '{\n  "order" : {\n    "pay_now" : "立即支付"\n  }\n}\n';
  const loc = findJsonKeyLocation(json, 'order.pay_now');
  assert.deepEqual(loc, { line: 2, character: 4 });
});

test('getValueByKey reads nested objects', () => {
  assert.equal(getValueByKey({ order: { pay_now: '立即支付' } }, 'order.pay_now'), '立即支付');
  assert.equal(getValueByKey({ order: {} }, 'order.pay_now'), undefined);
});


test('inlay hints show default locale translation after i18n key', () => {
  const text = 'const label = t("order.pay_now");';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } } };
  const hints = getInlayHints(text, { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }, locales, 'zh-CN');
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0].position, { line: 0, character: 31 });
  assert.equal(hints[0].label, '立即支付');
  assert.equal(hints[0].tooltip, '立即支付');
  assert.equal(hints[0].paddingLeft, true);
  assert.equal(Object.prototype.hasOwnProperty.call(hints[0], 'kind'), false);
});

test('inlay hints skip missing keys', () => {
  const text = 't("order.missing")';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } } };
  const hints = getInlayHints(text, { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }, locales, 'zh-CN');
  assert.deepEqual(hints, []);
});

test('inlay hints truncate long translations', () => {
  const text = 't("notice.long")';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'notice.long': '这是一个非常非常长的下单成功后的提示文案，需要被截断显示' } } };
  const hints = getInlayHints(text, { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }, locales, 'zh-CN', { maxLength: 12 });
  assert.equal(hints[0].label, '这是一个非常非常长的下…');
  assert.equal(hints[0].tooltip, '这是一个非常非常长的下单成功后的提示文案，需要被截断显示');
});

test('inlay hints only return items whose key starts inside requested range', () => {
  const text = 't("common.first")\nt("common.second")';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'common.first': '第一', 'common.second': '第二' } } };
  const hints = getInlayHints(text, { start: { line: 1, character: 0 }, end: { line: 1, character: text.split('\n')[1].length } }, locales, 'zh-CN');
  assert.deepEqual(hints.map((hint) => hint.label), ['第二']);
});


test('normalizeI18nLensConfig returns defaults when config is empty', () => {
  assert.deepEqual(normalizeI18nLensConfig({}), {
    defaultLocale: 'zh-CN',
    localeDirs: ['src/locales', 'src/i18n', 'locales', 'i18n'],
    inlayHints: { enabled: true, maxLength: 24 },
  });
});

test('normalizeI18nLensConfig accepts project overrides', () => {
  assert.deepEqual(normalizeI18nLensConfig({
    defaultLocale: 'en-US',
    localeDirs: ['app/lang'],
    inlayHints: { enabled: false, maxLength: 12 },
  }), {
    defaultLocale: 'en-US',
    localeDirs: ['app/lang'],
    inlayHints: { enabled: false, maxLength: 12 },
  });
});

test('normalizeI18nLensConfig ignores invalid values safely', () => {
  assert.deepEqual(normalizeI18nLensConfig({
    defaultLocale: '',
    localeDirs: ['', 42, null],
    inlayHints: { enabled: 'no', maxLength: -1 },
  }), {
    defaultLocale: 'zh-CN',
    localeDirs: ['src/locales', 'src/i18n', 'locales', 'i18n'],
    inlayHints: { enabled: true, maxLength: 24 },
  });
});

test('inlay hints can be disabled through options', () => {
  const text = 't("order.pay_now")';
  const locales = { 'zh-CN': { path: 'zh-CN.json', flat: { 'order.pay_now': '立即支付' } } };
  const hints = getInlayHints(text, { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }, locales, 'zh-CN', { enabled: false });
  assert.deepEqual(hints, []);
});




test('collectLocaleWatchPaths includes locale directories and loaded locale files', () => {
  const paths = collectLocaleWatchPaths({
    'zh-CN': { path: '/repo/src/locales/zh-CN', flat: {}, files: ['/repo/src/locales/zh-CN/common.json'] },
    'en-US': { path: '/repo/src/locales/en-US.json', flat: {}, files: ['/repo/src/locales/en-US.json'] },
  }, ['/repo/src/locales']);
  assert.deepEqual(paths, [
    '/repo/src/locales',
    '/repo/src/locales/en-US.json',
    '/repo/src/locales/zh-CN',
    '/repo/src/locales/zh-CN/common.json',
  ]);
});

test('didWatchedFileChange detects mtime changes and ignores unchanged files', () => {
  assert.equal(didWatchedFileChange({ mtimeMs: 10 }, { mtimeMs: 10 }), false);
  assert.equal(didWatchedFileChange({ mtimeMs: 10 }, { mtimeMs: 11 }), true);
});

test('didWatchedFileChange detects file creation and deletion', () => {
  assert.equal(didWatchedFileChange({ mtimeMs: 0 }, { mtimeMs: 11 }), true);
  assert.equal(didWatchedFileChange({ mtimeMs: 11 }, { mtimeMs: 0 }), true);
});
