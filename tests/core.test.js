import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenLocale,
  extractI18nKeys,
  extractPlaceholders,
  getValueByKey,
  buildHoverMarkdown,
  getDiagnostics,
  getParamCodeActions,
  getCompletions,
  getCompletionPrefix,
  getInlayHints,
  normalizeI18nLensConfig,
  mergeI18nLensConfig,
  resolveConfigPath,
  didWatchedFileChange,
  resolvePreferredLocale,
  getDefinitionLocaleOrder,
  collectLocaleWatchPaths,
  findJsonKeyLocation,
  findLocaleKeyTarget,
  collectLocaleKeyTargets,
  localeKeyAtPosition,
  findCodeKeyRanges,
  resolveProjectContext,
} from '../server/core.js';

test('resolveConfigPath points to the Zed project config file', () => {
  assert.equal(resolveConfigPath('F:/code/repo'), 'F:/code/repo/.zed/i18nlensrc.json');
  assert.equal(resolveConfigPath('F:\\code\\repo\\'), 'F:/code/repo/.zed/i18nlensrc.json');
});

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

test('extractI18nKeys detects Vue i18n plural tc and $tc calls', () => {
  const keys = extractI18nKeys('tc("cart.items"); $tc("cart.count")').map((x) => x.key);
  assert.deepEqual(keys, ['cart.items', 'cart.count']);
});

test('extractI18nKeys detects the <i18n-t keypath> component', () => {
  const keys = extractI18nKeys('<i18n-t keypath="order.summary" tag="p" />').map((x) => x.key);
  assert.deepEqual(keys, ['order.summary']);
});

test('extractI18nKeys detects react-i18next <Trans i18nKey>', () => {
  const keys = extractI18nKeys('<Trans i18nKey="user.greeting">Hi</Trans>').map((x) => x.key);
  assert.deepEqual(keys, ['user.greeting']);
});

test('extractI18nKeys detects react-intl formatMessage id and lands the range on the key', () => {
  const text = 'intl.formatMessage({ id: "nav.home" }); formatMessage({ defaultMessage: "x", id: "nav.about" })';
  const items = extractI18nKeys(text);
  assert.deepEqual(items.map((x) => x.key), ['nav.home', 'nav.about']);
  assert.equal(text.slice(items[0].startOffset, items[0].endOffset), 'nav.home');
});

test('extractI18nKeys does not misfire on lookalike identifiers', () => {
  const text = 'route("home"); delete(x); const note = t("real.key")';
  const keys = extractI18nKeys(text).map((x) => x.key);
  assert.deepEqual(keys, ['real.key']);
});

test('extractI18nKeys collects provided named params from i18n calls', () => {
  const items = extractI18nKeys('t("cart.items", { count, name: user.name }); tc("cart.total", total, { amount })');
  assert.deepEqual(items.map((x) => ({ key: x.key, providedParams: x.providedParams })), [
    { key: 'cart.items', providedParams: ['count', 'name'] },
    { key: 'cart.total', providedParams: ['amount'] },
  ]);
});

test('extractPlaceholders returns ICU-style named placeholders', () => {
  assert.deepEqual(extractPlaceholders('Hello {name}, you have {count, plural, one {item} other {items}}.'), ['count', 'name']);
});

test('getCompletionPrefix triggers inside the new i18n syntaxes', () => {
  assert.equal(getCompletionPrefix('$tc("cart.', { line: 0, character: 10 }), 'cart.');
  assert.equal(getCompletionPrefix('<i18n-t keypath="order.', { line: 0, character: 23 }), 'order.');
  assert.equal(getCompletionPrefix('<Trans i18nKey="user.', { line: 0, character: 21 }), 'user.');
  assert.equal(getCompletionPrefix('formatMessage({ id: "nav.', { line: 0, character: 25 }), 'nav.');
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

test('diagnostics reports missing and unused i18n params', () => {
  const text = 't("cart.items", { total, extra })';
  const locales = {
    'en-US': { path: 'en-US.json', flat: { 'cart.items': 'You have {count} items' } },
    'zh-CN': { path: 'zh-CN.json', flat: { 'cart.items': '共 {count} 件商品' } },
  };
  const diagnostics = getDiagnostics(text, locales);
  assert.deepEqual(diagnostics.map((item) => item.message), [
    'Missing i18n params for "cart.items": count',
    'Unused i18n params for "cart.items": extra, total',
  ]);
});

test('diagnostics accepts matching i18n params', () => {
  const text = 't("cart.items", { count })';
  const locales = { 'en-US': { path: 'en-US.json', flat: { 'cart.items': 'You have {count} items' } } };
  assert.deepEqual(getDiagnostics(text, locales), []);
});

test('diagnostics validates react-intl formatMessage params', () => {
  const text = 'formatMessage({ id: "user.greeting" }, { firstName })';
  const locales = { 'en-US': { path: 'en-US.json', flat: { 'user.greeting': 'Hello {name}' } } };
  const diagnostics = getDiagnostics(text, locales);
  assert.deepEqual(diagnostics.map((item) => item.message), [
    'Missing i18n params for "user.greeting": name',
    'Unused i18n params for "user.greeting": firstName',
  ]);
});

test('param code actions add missing params to existing object args', () => {
  const text = 't("cart.items", { total })';
  const locales = { 'en-US': { path: 'en-US.json', flat: { 'cart.items': 'You have {count} items' } } };
  const actions = getParamCodeActions(text, getDiagnostics(text, locales));
  const offset = actions[0].edit.range.start.character;
  assert.equal(actions[0].title, 'Add missing i18n params: count');
  assert.equal(text.slice(0, offset) + actions[0].edit.newText + text.slice(offset), 't("cart.items", { total, count })');
});

test('param code actions create object args when none exist', () => {
  const text = 't("cart.items")';
  const locales = { 'en-US': { path: 'en-US.json', flat: { 'cart.items': 'You have {count} items' } } };
  const actions = getParamCodeActions(text, getDiagnostics(text, locales));
  const offset = actions[0].edit.range.start.character;
  assert.equal(text.slice(0, offset) + actions[0].edit.newText + text.slice(offset), 't("cart.items", { count })');
});

test('param code actions add missing react-intl params', () => {
  const text = 'formatMessage({ id: "user.greeting" }, { firstName })';
  const locales = { 'en-US': { path: 'en-US.json', flat: { 'user.greeting': 'Hello {name}' } } };
  const actions = getParamCodeActions(text, getDiagnostics(text, locales));
  const offset = actions[0].edit.range.start.character;
  assert.equal(text.slice(0, offset) + actions[0].edit.newText + text.slice(offset), 'formatMessage({ id: "user.greeting" }, { firstName, name })');
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

test('findLocaleKeyTarget resolves keys inside prefixed locale directory files', () => {
  const locale = {
    path: '/repo/src/locales/zh-CN',
    flat: { 'common.ok': '确定' },
    files: ['/repo/src/locales/zh-CN/common.json'],
  };
  const localeTexts = {
    '/repo/src/locales/zh-CN/common.json': '{\n  "ok": "确定"\n}\n',
  };

  assert.deepEqual(findLocaleKeyTarget(locale, 'common.ok', localeTexts), {
    filePath: '/repo/src/locales/zh-CN/common.json',
    position: { line: 1, character: 2 },
  });
});

test('collectLocaleKeyTargets returns every locale that defines the key, default locale first', () => {
  const locales = {
    'en-US': { path: '/repo/src/locales/en-US.json', flat: { 'common.ok': 'OK' }, files: ['/repo/src/locales/en-US.json'] },
    'zh-CN': { path: '/repo/src/locales/zh-CN', flat: { 'common.ok': '确定' }, files: ['/repo/src/locales/zh-CN/common.json'] },
    'ja-JP': { path: '/repo/src/locales/ja-JP.json', flat: {}, files: ['/repo/src/locales/ja-JP.json'] },
  };
  const localeTexts = {
    '/repo/src/locales/en-US.json': '{\n  "common": {\n    "ok": "OK"\n  }\n}\n',
    '/repo/src/locales/zh-CN/common.json': '{\n  "ok": "确定"\n}\n',
  };

  const targets = collectLocaleKeyTargets(locales, 'common.ok', localeTexts, 'zh-CN');
  assert.deepEqual(targets, [
    { filePath: '/repo/src/locales/zh-CN/common.json', position: { line: 1, character: 2 } },
    { filePath: '/repo/src/locales/en-US.json', position: { line: 2, character: 4 } },
  ]);
});

test('findCodeKeyRanges returns every source usage of a key', () => {
  const text = 'const a = t("order.pay_now")\nconst b = $t("common.ok")\nconst c = t("order.pay_now")';
  const ranges = findCodeKeyRanges(text, 'order.pay_now');
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0].start, { line: 0, character: 13 });
  assert.deepEqual(ranges[1].start, { line: 2, character: 13 });
});

test('localeKeyAtPosition resolves the full key from a flat JSON caret', () => {
  const locale = {
    path: '/repo/src/locales/zh-CN.json',
    flat: { 'order.pay_now': '立即支付' },
    files: ['/repo/src/locales/zh-CN.json'],
  };
  const text = '{\n  "order": {\n    "pay_now": "立即支付"\n  }\n}\n';
  assert.equal(localeKeyAtPosition(locale, locale.path, text, { line: 2, character: 8 }), 'order.pay_now');
  assert.equal(localeKeyAtPosition(locale, locale.path, text, { line: 0, character: 0 }), undefined);
});

test('localeKeyAtPosition restores the file-stem prefix for nested locale files', () => {
  const locale = {
    path: '/repo/src/locales/zh-CN',
    flat: { 'common.ok': '确定' },
    files: ['/repo/src/locales/zh-CN/common.json'],
  };
  const text = '{\n  "ok": "确定"\n}\n';
  assert.equal(
    localeKeyAtPosition(locale, '/repo/src/locales/zh-CN/common.json', text, { line: 1, character: 4 }),
    'common.ok',
  );
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
    packages: [],
  });
});

test('mergeI18nLensConfig combines Zed settings with project config', () => {
  const merged = mergeI18nLensConfig(
    { defaultLocale: 'en-US', localeDirs: ['locales'], inlayHints: { enabled: false, maxLength: 18 } },
    { localeDirs: ['src/i18n'], inlayHints: { maxLength: 32 } },
  );
  assert.deepEqual(merged, {
    defaultLocale: 'en-US',
    localeDirs: ['src/i18n'],
    inlayHints: { enabled: false, maxLength: 32 },
    packages: undefined,
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
    packages: [],
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
    packages: [],
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


test('normalizeI18nLensConfig accepts monorepo package overrides and inherits defaults', () => {
  assert.deepEqual(normalizeI18nLensConfig({
    defaultLocale: 'en-US',
    localeDirs: ['shared/locales'],
    inlayHints: { enabled: true, maxLength: 18 },
    packages: [
      { root: 'apps/web', defaultLocale: 'zh-CN', localeDirs: ['src/locales'] },
      { root: './packages/admin', inlayHints: { enabled: false } },
      { localeDirs: ['ignored'] },
    ],
  }), {
    defaultLocale: 'en-US',
    localeDirs: ['shared/locales'],
    inlayHints: { enabled: true, maxLength: 18 },
    packages: [
      { root: 'apps/web', defaultLocale: 'zh-CN', localeDirs: ['src/locales'], inlayHints: { enabled: true, maxLength: 18 } },
      { root: 'packages/admin', defaultLocale: 'en-US', localeDirs: ['shared/locales'], inlayHints: { enabled: false, maxLength: 18 } },
    ],
  });
});

test('resolveProjectContext selects the longest matching monorepo package root', () => {
  const config = normalizeI18nLensConfig({
    defaultLocale: 'en-US',
    localeDirs: ['root-locales'],
    packages: [
      { root: 'apps/web', defaultLocale: 'zh-CN', localeDirs: ['src/locales'] },
      { root: 'apps/web-admin', defaultLocale: 'ja-JP', localeDirs: ['src/lang'] },
    ],
  });

  const web = resolveProjectContext('F:/code/repo/apps/web/src/App.vue', 'F:/code/repo', config);
  assert.equal(web.root, 'F:/code/repo/apps/web');
  assert.equal(web.config.defaultLocale, 'zh-CN');
  assert.deepEqual(web.config.localeDirs, ['src/locales']);

  const admin = resolveProjectContext('F:/code/repo/apps/web-admin/src/App.vue', 'F:/code/repo', config);
  assert.equal(admin.root, 'F:/code/repo/apps/web-admin');
  assert.equal(admin.config.defaultLocale, 'ja-JP');

  const root = resolveProjectContext('F:/code/repo/tools/script.ts', 'F:/code/repo', config);
  assert.equal(root.root, 'F:/code/repo');
  assert.equal(root.config.defaultLocale, 'en-US');
});
