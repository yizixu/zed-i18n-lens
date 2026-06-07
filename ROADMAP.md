# Zed i18n Lens 路线计划

> **For Hermes:** 后续如果要按本计划继续实现，请优先使用 `subagent-driven-development` + `test-driven-development`，按任务逐项实现、逐项验证。

**Goal:** 把当前已支持行内翻译和项目配置的 MVP 打磨成一个稳定、可配置、可发布的 Zed i18n 辅助插件。

**Architecture:** 继续保持「Zed Extension 薄壳 + Node.js Language Server + 可测试 core」架构。Zed Rust/WASM 层只负责注册和启动 LSP；复杂逻辑都放在 `server/core.js` / `server/index.js`，并通过 `tests/core.test.js` 覆盖。

**Tech Stack:** Zed Extension API、Rust/WASM、Node.js ESM、`vscode-languageserver`、Node built-in test runner。

---

## 当前状态

当前 MVP 已具备：

- Zed Dev Extension 可加载
- Language Server 可通过 `--stdio` 启动
- 支持文件：`.vue`、`.ts`、`.tsx`、`.js`、`.jsx`
- 支持 locale 路径：
  - `src/locales/*.json`
  - `src/i18n/*.json`
  - `locales/*.json`
  - `i18n/*.json`
- 支持能力：
  - Inlay Hints 行内显示默认语言翻译
  - Hover 查看 key 对应多语言翻译
  - Diagnostics 提示完全不存在的 key
  - Completion 补全已有 i18n key
  - Definition 跳转到 JSON locale 定义
- 已有自动化测试：`npm test`，当前 19 个测试通过
- Zed extension 编译验证：`cargo check --target wasm32-wasip1`

---

## 已完成里程碑

### v0.3.0: Project configuration 项目配置

**Status:** Done

已完成项目级配置文件支持，让插件从写死默认值升级为可适配真实项目。

已落地内容：

- 支持读取工作区根目录 `.i18nlensrc.json`
- 新增 `.i18nlensrc.example.json` 示例配置
- `defaultLocale` 可配置，影响 completion detail 和行内翻译文案
- `localeDirs` 可配置，影响 locale 文件扫描目录
- `inlayHints.enabled` 可配置，可关闭本插件行内提示
- `inlayHints.maxLength` 可配置，影响行内文案截断长度
- 配置缺失、字段非法或 JSON 解析失败时安全回退默认值
- 保存文档时重新加载配置和 locale cache
- `.i18nlensrc.json` 修改后自动生效，无需 rebuild / reload extension
- 配置变更触发 debounce reload，刷新 config、locale cache、diagnostics 和 inlay hints
- `tests/core.test.js` 新增配置规范化和 inlay hint 关闭测试

验证命令：

```bash
npm test
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

验证结果：

```text
19 tests passed
cargo check passed
```

### v0.2.0: Inlay Hints 行内翻译

**Status:** Done

已提前完成最核心的产品体验：在代码里直接行内显示默认语言文案。

已落地内容：

- `server/index.js` 声明 `inlayHintProvider: true`
- `server/index.js` 注册 `connection.languages.inlayHint.on(...)`
- `server/core.js` 新增 `getInlayHints()`
- 行内提示使用默认 locale，当前为 `zh-CN`
- 缺失 key 不显示行内提示，由 diagnostics 负责提示
- 长文案行内截断，避免干扰编辑体验
- range 内过滤，适配 LSP inlay hint 请求
- `tests/core.test.js` 新增 4 个 inlay hint 测试
- `README.md` 增加 inline translations 使用说明
- `CHANGELOG.md` 记录 `0.2.0` 版本历史
- `package.json` / `extension.toml` 版本升级到 `0.2.0`

验证命令：

```bash
npm test
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

验证结果：

```text
13 tests passed
cargo check passed
```

---

## 近期目标：把 MVP 做稳

### Task 1: 修正文档与实际识别能力不一致（已部分完成）

**Objective:** 让 README 准确描述当前支持的写法，避免误导使用者。

**Status:** Partially done in `v0.2.0`：README 已补充行内翻译、本地开发与 Zed 测试说明；后续仍可继续细化截图/GIF、配置项说明。

**Files:**

- Modify: `README.md`
- Optional Test: `tests/core.test.js`

**Steps:**

1. 检查 `server/core.js` 中 `extractI18nKeys()` 的实际正则。
2. 更新 README 中的「MVP features」：
   - 明确支持 `$t("key")`
   - 明确支持 `t("key")`
   - 明确支持 `i18n.t("key")`
   - 明确支持 `v-t="'key'"`
   - 明确支持 `v-t="{ path: 'key' }"`
3. 增加本地开发说明：
   - `npm install`
   - `npm test`
   - `cargo check --target wasm32-wasip1`
   - Zed 中使用 `Install Dev Extension` 加载项目根目录
4. 运行验证：

```bash
npm test
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

**Expected:** 测试通过，Rust 编译通过。

---

### Task 2: 增加缺失语言提示

**Objective:** 当前 diagnostics 只提示「所有 locale 都不存在」的 key；下一步增加「某些语言缺失」的 warning。

**Files:**

- Modify: `server/core.js`
- Modify: `tests/core.test.js`

**Acceptance Criteria:**

如果 locale 如下：

```js
const locales = {
  'zh-CN': { flat: { 'order.pay_now': '立即支付' } },
  'en-US': { flat: {} },
};
```

代码中出现：

```ts
t("order.pay_now")
```

应产生 warning：

```text
Missing i18n key "order.pay_now" in locales: en-US
```

但不应当作为 error 处理。

**Steps:**

1. 先在 `tests/core.test.js` 添加测试：
   - key 至少存在于一个 locale
   - 但缺失于另一个 locale
   - 期望 diagnostic severity 为 warning
2. 修改 `getDiagnostics(text, locales)`：
   - 完全不存在：保持 error
   - 部分 locale 缺失：新增 warning
3. 保持没有 locale 文件时不报大量误报。
4. 运行：

```bash
npm test
```

**Expected:** 新增测试通过，原测试不回归。

---

### Task 3: 支持配置默认语言 defaultLocale

**Objective:** 现在默认语言写死为 `zh-CN`，应支持从初始化配置或 workspace 配置读取。

**Files:**

- Modify: `server/index.js`
- Modify: `server/core.js` if needed
- Modify: `tests/core.test.js`
- Modify: `README.md`

**Acceptance Criteria:**

- 默认仍为 `zh-CN`
- 用户可配置默认语言，如 `en-US`
- Completion 的 `detail` 使用默认语言文本

**Suggested Config Shape:**

```json
{
  "i18nLens.defaultLocale": "en-US"
}
```

**Steps:**

1. 增加纯函数测试，验证 `getCompletions(prefix, locales, 'en-US')` 使用英文文本。
2. 在 LSP 初始化阶段记录配置默认值。
3. 如 Zed 暂时不方便传 settings，则先保留服务器内部配置入口，并在 README 标记为 upcoming / experimental。
4. 运行：

```bash
npm test
```

---

### Task 4: 支持更多 locale 文件形态

**Objective:** 支持更接近真实项目的 locale 组织方式。

**Files:**

- Modify: `server/index.js`
- Modify: `server/core.js`
- Modify: `tests/core.test.js`

**Target Structures:**

```text
src/locales/zh-CN/common.json
src/locales/zh-CN/order.json
src/locales/en-US/common.json
src/locales/en-US/order.json
```

已经有部分目录支持逻辑，但需要补充测试、文档和边界处理。

**Acceptance Criteria:**

- `src/locales/zh-CN/common.json` 中 `{ "ok": "确定" }` 被识别为 `common.ok`
- `src/locales/zh-CN/index.json` 不额外加 `index.` 前缀
- Definition 能跳转到子文件中的 key

**Steps:**

1. 为 `prefixByFile()` 和 `loadLocaleDirectory()` 增加测试入口或提取为可测试函数。
2. 补充目录式 locale 的 fixture 测试。
3. 确认 definition 对子文件路径正确。
4. 更新 README 的 Locale discovery 章节。
5. 运行：

```bash
npm test
```

---

### v0.4.0: Missing locale warnings 部分语言缺失提示

**Status:** Done

已完成 diagnostics 增强：

- key 在所有 locale 都缺失时继续作为 error 报告
- key 至少存在于一个 locale、但缺失于其他 locale 时作为 warning 报告
- warning 信息列出缺失的 locale 名称
- diagnostic `data` 包含 `missingLocales` 和 `missingInAllLocales`
- 没有 locale 文件时不产生大量误报
- locale 文件或 locale 目录变化后自动 reload locale cache、刷新 diagnostics 和 inlay hints
- 自动化测试覆盖完整缺失、部分缺失、全部存在、无 locale cache 四种情况
- 集成验证覆盖只修改 locale 文件、不修改源码时自动发布 warning diagnostics
- Ctrl+点击 definition 优先跳转到配置的 `defaultLocale` 文件，支持 `ZH` -> `zh-CN` 这类别名匹配

验证结果：

```text
25 tests passed
cargo check passed
```

---

## 中期目标：提升真实项目可用性

### Task 5: 支持 TypeScript locale module

**Objective:** 支持真实项目常见的 `zh-CN.ts` / `en-US.ts` locale 文件。

**Files:**

- Modify: `server/core.js`
- Modify: `server/index.js`
- Modify: `tests/core.test.js`

**Target Examples:**

```ts
export default {
  common: {
    submit: '提交',
  },
};
```

```ts
export const common = {
  submit: '提交',
};
```

**Acceptance Criteria:**

- 能解析简单 object literal
- 不执行用户代码
- 不支持复杂表达式时要安全失败，不崩溃

**Implementation Note:**

当前 `parseTsLocaleModule()` 已存在初步逻辑。先补测试，再逐步增强。不要引入完整 TypeScript 编译器，除非确实需要。

---

### Task 6: 增加 Code Action：创建缺失 key

**Objective:** 用户在缺失 key 上触发 quick fix，自动往默认 locale 文件写入占位翻译。

**Files:**

- Modify: `server/index.js`
- Modify: `server/core.js`
- Modify: `tests/core.test.js`

**Acceptance Criteria:**

当代码里存在：

```ts
t("order.pay_now")
```

但 locale 文件不存在该 key 时，Code Action 提供：

```text
Create i18n key "order.pay_now"
```

执行后写入：

```json
{
  "order": {
    "pay_now": "TODO: order.pay_now"
  }
}
```

**Risk:** 直接写 JSON 有格式化风险。必须先实现纯函数：

```js
insertNestedJsonKey(jsonText, key, value)
```

并用测试覆盖。

---

### Task 7: 增加 Rename：重命名 key 并同步 locale

**Objective:** 支持从代码或 locale 中重命名 i18n key。

**Files:**

- Modify: `server/index.js`
- Modify: `server/core.js`
- Modify: `tests/core.test.js`

**Acceptance Criteria:**

- 从 `order.pay_now` 重命名为 `order.payNow`
- 修改代码引用
- 修改所有 locale 文件中的 key
- 保留翻译值不变

**Risk:** 这是高风险能力，必须在 Code Action 稳定后再做。

---

### Task 8: 增加项目级扫描报告

**Objective:** 提供一个命令或 LSP 自定义能力，扫描整个项目并输出 i18n 健康报告。

**Files:**

- Create: `server/report.js`
- Create: `tests/report.test.js`
- Modify: `package.json`
- Modify: `README.md`

**Report Should Include:**

- 代码中使用但 locale 不存在的 key
- locale 中存在但代码未使用的 key
- 每个语言缺失数量
- 重复 key / 冲突 key

**CLI Shape:**

```bash
node server/report.js --root . --format markdown
```

**Expected Output:**

```markdown
# i18n Lens Report

## Missing Keys
- order.pay_now: used in src/pages/order.tsx:12

## Unused Keys
- legacy.old_title: defined in src/locales/zh-CN.json
```

---

## 长期目标：发布与产品化

### Task 9: 增加配置文件支持

**Objective:** 支持项目根目录配置 `.i18nlensrc.json`。

**Suggested Config:**

```json
{
  "defaultLocale": "zh-CN",
  "localeDirs": ["src/locales", "src/i18n"],
  "sourceGlobs": ["src/**/*.{ts,tsx,vue,js,jsx}"],
  "ignoreKeys": ["debug.*"],
  "functionNames": ["t", "$t", "i18n.t"]
}
```

**Acceptance Criteria:**

- 没有配置文件时行为不变
- 配置文件错误时给出清晰 warning
- 测试覆盖默认值、覆盖值、错误值

---

### Task 10: 支持更多 i18n 框架写法

**Objective:** 覆盖常见生态。

**Target Patterns:**

```tsx
<Trans i18nKey="common.submit" />
```

```tsx
intl.formatMessage({ id: "common.submit" })
```

```ts
$t('common.submit')
```

```vue
<i18n-t keypath="common.submit" />
```

**Acceptance Criteria:**

- 每种模式都有测试
- range 精准落在 key 字符串上
- 不明显误报普通字符串

---

### Task 11: 性能优化与缓存

**Objective:** 大型项目中避免每次 hover/completion 都全量扫描 locale。

**Approach:**

- locale 文件变更时再重建 cache
- 普通 source 文件变更时只重新诊断当前文件
- 增加简单 debounce
- 记录 cache build 时间到 LSP console

**Acceptance Criteria:**

- 1000+ keys 的 locale 文件 hover 无明显卡顿
- 保存 locale 文件后诊断会刷新
- 测试覆盖 cache invalidation 的核心纯函数

---

### Task 12: 发布准备

**Objective:** 准备提交到 Zed extension registry 或作为 GitHub 项目发布。

**Files:**

- Modify: `extension.toml`
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Create: `.github/workflows/ci.yml`

**Checklist:**

- `repository` 改成真实 GitHub URL
- `authors` 邮箱改成真实或移除占位
- README 增加截图/GIF
- README 增加安装方式
- CI 跑：
  - `npm ci`
  - `npm test`
  - `cargo check --target wasm32-wasip1`
- 打 tag：`v0.1.0`

---

## 推荐优先级

已完成：

- `v0.2.0`：Inlay Hints 行内翻译
- `v0.3.0`：项目配置 `.i18nlensrc.json`
- README / CHANGELOG 基础文档更新

接下来建议优先做：

1. 目录式 locale 完整测试
3. TypeScript locale module 增强
4. Code Action 创建缺失 key
5. 项目级扫描报告
6. 更多 i18n 框架写法
7. 性能优化与缓存
8. Rename 同步重命名 key
9. 发布准备

---

## 每次开发后的固定验证

每完成一个任务，都运行：

```bash
npm test
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

如果在 Windows 原生终端里运行，也可以用：

```powershell
npm test
cargo check --target wasm32-wasip1
```

Zed 手动验证：

1. 重新加载 Dev Extension
2. 打开包含 locale 文件的前端项目
3. 测试 hover、completion、diagnostics、definition
4. 查看 Zed 日志，确认 language server 没有报错

---

## 不做事项 / 边界

近期不要做：

- 复杂 WebView UI
- 自动机器翻译调用外部 LLM/API
- 大规模自动重构
- 执行用户 locale `.ts` 文件代码
- 一次性支持所有 i18n 框架

原则：先把核心 LSP 体验做稳，再逐步扩展。
