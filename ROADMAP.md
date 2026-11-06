# Zed i18n Lens 路线计划

**Goal:** 把 i18n key 的翻译提示做成 Zed 里稳定、可配置、可持续发布的能力。

**Architecture:** 继续保持「Zed Extension 薄壳 + Node.js Language Server + 可测试 core」架构。Zed Rust/WASM 层只负责注册和启动 LSP；复杂逻辑都放在 `server/core.js` / `server/index.js`，并通过 `tests/` 覆盖。

**Tech Stack:** Zed Extension API、Rust/WASM、Node.js ESM、`vscode-languageserver`、Node built-in test runner。

---

## 当前状态

当前代码已具备（v0.15.0 发布准备中，尚未发布到 npm）：

- Zed Dev Extension 可加载，已通过 npm 发布 `i18n-lens-language-server`
- Language Server 可通过 `--stdio` 启动
- 支持文件：`.vue`、`.ts`、`.tsx`、`.js`、`.jsx`、`.html`、`.json`、`.jsonc`
- 识别写法：`$t`/`t`/`tc`/`$tc`/`i18n.t`/`i18n.tc`、`v-t="'key'"`、`v-t="{ path }"`、`<i18n-t keypath>`、react-i18next `<Trans i18nKey>`、react-intl `formatMessage({ id })`
- 支持 locale 形态：
  - `src/locales/*.json`、`src/i18n/*.json`、`locales/*.json`、`i18n/*.json`
  - 目录式：`src/locales/<locale>/<ns>.json`（按文件名加命名空间前缀）
  - 多层目录：`src/locales/<locale>/system/user.json` → `system.user.*`（`index` 文件归入父命名空间）
  - TypeScript / JavaScript locale module：`<locale>.ts`、`<locale>/<ns>.ts`（静态解析，不执行用户代码）
- 支持能力：
  - Inlay Hints 行内显示默认语言翻译
  - Hover 查看 key 对应多语言翻译
  - Diagnostics：全缺为 error，部分语言缺失为 warning，并校验 interpolation params
  - Completion 补全已有 i18n key
  - Definition 跳转到 locale 定义，多语言时返回每个语言的位置
  - Code Action：增删 interpolation params；在单文件及目录式 JSON locale 中安全创建缺失 key，支持多层目录布局与目标文件创建
  - Extract / Inline：显式提取 Vue/HTML 模板原文到首选语言 JSON；把无参数翻译调用替换为所选语言的原文
  - References：从源码或 JSON/TS locale 定义查引用，隔离独立子包并包含尚未落盘的打开源码
  - 编辑安全：读取未保存 locale，版本化最小编辑，拒绝歧义 JSON 路径及目录路由
- 项目配置 `.zed/i18nlensrc.json`（`defaultLocale` / `localeDirs` / `inlayHints` / `rawTextDiagnostics` / `packages`），支持 monorepo `packages` 多上下文
- 自动化验证：`npm test`（纯函数 + 真实 stdio LSP 回归，178 项）
- Zed extension 编译验证：`cargo check --target wasm32-wasip1`

---

## v0.15.0 发布阻塞项

- Inline 会把无分号的普通 JS/TS 赋值（如 `const label = t('greet')`）误判为 HTML 属性：实体文本被二次转义，含换行的译文可生成语法错误
- 发布准备 PR 保持草稿；需先单独修复上下文识别，并补上无分号赋值、实体文本和多行译文的回归测试，再重新验证打包产物
- 本次只准备版本与文档，不以文档披露代替上述修复，也不触发 npm 发布

---

## 已完成

按版本倒序，只列结果，细节见 `CHANGELOG.md`。

### v0.15.0（待发布）: Extract / Inline

- Extract / Inline 已通过 PR #4 合入，Rename 继续由 issue #2 单独跟踪
- 提取仅在 Vue/HTML 光标或选区显式触发，不依赖 raw-text 诊断，也不改变其保守规则
- 提取创建新 key、避开父级叶子及重名冲突；内联处理属性引号、实体、花括号、JSX 和 HTML script 转义，跳过部分属性表达式
- Extract / Inline 异常单独捕获，不丢弃已有快速修复；覆盖未保存 locale、坏 JSON 和后续服务请求
- README 补充使用方式及边界：Inline 只替换原文、不执行运行时解析；多文件编辑失败回滚仍待验证

### v0.14.0: 多层语言目录

- 递归加载嵌套 JSON/TS/JS 语言文件，按相对路径生成命名空间，`index` 归入父命名空间
- 嵌套文件的提示、定义、引用、未保存内容更新全部适配
- 新增/删除嵌套目录文件自动刷新，无需重启服务
- 修复：非 `index` 的 TS/JS 模块不再按 index 解析，默认导出优先于局部辅助对象
- 修复：区分根 `index.json` 与真实 `index/` 目录命名空间，快速修复不再多写一层
- 修复：定义/引用跟随实际提供翻译值的文件
- 修复：重叠 `localeDirs` 不再产生虚假语言，深层嵌套与配置顺序均正确；无文件的中间目录仍被监听

### v0.13.0: 可信编辑与目录式 key 创建

- 目录式 JSON locale 创建缺失 key，正确剥离文件名命名空间
- 仅在兄弟语言布局可确定目标、且客户端支持创建文件时创建新文件
- 未保存 locale 优先、版本化最小编辑、结构化 JSON 定位
- 源码识别降噪、补全限定在 i18n 上下文、顶层 TS/JS 加载与反向引用、子包引用隔离

### v0.12.0: 模板原文诊断

- 可选的 raw-text 诊断，覆盖 Vue SFC 模板与 HTML 中的疑似未翻译文本
- 支持静态 `title` / `alt` / `placeholder` / `label` / `aria-label` 属性
- 跳过 script、style、注释、插值、翻译组件与显式 `translate="no"` 子树

### v0.11.x: 参数诊断与创建 key

- 跨语言占位符一致性诊断（locale 文件与源码使用处）
- 缺失 params / 多余 params quick fix
- 创建缺失 key（后续版本扩展为目录式与多层目录）

### v0.10.0: Find References

- 从 locale 定义或源码用法双向查找引用
- LSP 注册 JSON/JSONC，可直接从 locale 文件发起

### v0.9.0: Zed settings 配置桥接

- `lsp.i18n-lens.settings` 转发为 initializationOptions / workspace configuration
- 项目配置覆盖 Zed 设置，`inlayHints` 深度合并，变更实时生效

### 更早

- v0.8.2 占位符参数诊断 · v0.6.0 多语言 Definition · v0.5.0 TS locale module · v0.4.0 部分语言缺失 warning · v0.3.0 项目配置 · v0.2.0 Inlay Hints

---

## 待办

### Task 1: Rename：重命名 key 并同步 locale

**Status:** 未开始。风险最高的一项。

**Objective:** 从源码用法或 locale 定义重命名 key，同步所有引用与所有语言文件。

**Acceptance Criteria:**

- `order.pay_now` → `order.payNow`，代码引用与所有 locale 文件同步更新
- 翻译值不变，空父对象按需清理
- 冲突（目标已存在、父子 key 冲突、移动到其他命名空间文件）明确拒绝，不执行部分重命名
- 无法准确定位或完整扫描时拒绝操作，而不是猜测

**约束:**

- TS/JS locale module 只能安全重命名最后一段；定位是 line-based best-effort，不能直接用于写入
- Zed 目前只把 rename 发给第一个声明支持的服务（zed-industries/zed#53411 尚未合并），Vue 文件中通常会被 vtsls / vue-ls 接走。功能可以先实现，但要在 README 说明实际触发条件
- 参考 fork `0froq/zed-i18n-lens` 分支 `feat/extract-inline-actions`，但需在其基础上修复已知边界（同名属性定位、引号转义等）

### Task 2: 项目级扫描报告

**Status:** 未开始。

**Objective:** 提供 CLI 或 LSP 命令，扫描项目输出 i18n 健康报告。

**Files:** `server/report.js`、`tests/report.test.js`、`package.json`、`README.md`

**报告内容:**

- 代码中使用但 locale 不存在的 key（带使用位置）
- locale 中定义但代码未使用的 key
- 每个语言缺失数量、参数不一致、空翻译
- 重复 key / 冲突 key

**CLI 形态:**

```bash
node server/report.js --root . --format markdown
```

**边界:** 必须显式报告扫描范围与上限（当前源码扫描约 5,000 文件），不能自动删除可能被动态引用的 key。

### Task 3: 编辑失败与 Inline 边界验证

**Status:** Extract / Inline 已合入 PR #4，以下验证后续单独推进，不阻塞本次发布准备。

- 补充多文件 workspace edit 在权限失败等情况下的客户端行为与回滚验证，不能仅凭服务端返回了完整 edit 就保证原子性
- Inline 当前只插入 locale 原文，不执行插值、复数、关联消息或其他运行时解析；有额外参数的调用不提供操作，但无参数不等于译文不依赖运行时，用户仍需检查结果
- 常量折叠等语义扩展另行设计，不纳入当前 Inline 的承诺

### Task 4: 框架与写法扩展

**Status:** 部分完成。

已覆盖 Vue I18n 复数、`<i18n-t>`、react-i18next `<Trans>`、react-intl `formatMessage`。仍可扩展：`<FormattedMessage id>`、`$te`/`te`（exists 检查）、函数名/属性名可配置。

### Task 5: 性能与缓存

**Status:** 已有基础缓存，未系统验证。

- 1000+ keys 的 locale hover 无明显卡顿
- 普通源文件变更只重算当前文件
- 缓存失效逻辑有纯函数测试覆盖

### Task 6: 产品化收尾

- README 截图 / GIF
- 项目级 CI（当前只有 tag 触发的 Release 工作流，PR 无检查）
- Assistant slash command 报告，待扫描报告稳定后再做

---

## 已知边界

- TS/JS locale module 的 key 定位是 line-based best-effort，不是完整语法树
- locale 写入类 Code Action 只支持 JSON locale；TS/JS module 与 JSONC 仍不支持写入
- Extract 同时编辑源码和首选语言文件；权限失败等情况下的多文件回滚未验证，不保证客户端原子应用
- Inline 只替换 locale 原文，不执行插值、复数或关联消息的运行时解析
- TS/JS module 只能安全重命名最后一段 key
- locale 加载器不执行用户代码，复杂表达式会被忽略而不是求值
- 源码扫描有文件数上限（约 5,000），大仓库结果不是完整性保证
- 不自动删除疑似未使用的 key，避免误删动态引用

---

## Zed Extension API 调研结论（0.7.0）

当前 docs.rs latest 仍为 `zed_extension_api 0.7.0`，项目已使用该版本，无需升级。已落地：

1. **Zed settings 配置桥接** — `language_server_workspace_configuration`、`settings::LspSettings::for_worktree`（v0.9.0）

尚未使用的方向：

2. **Assistant Slash Command 报告** — `run_slash_command`、`complete_slash_command_argument`
3. **Context Server** — `context_server_command`、`context_server_configuration`，把 locale index / key 使用暴露给 Assistant
4. **Zed AI API** — `0.7.0` 没有稳定的 Inline AI / Agent Edit 接口，AI 自动抽取文案暂缓

---

## 每次开发后的固定验证

```bash
npm test
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

Windows 原生终端可直接用 `cargo check --target wasm32-wasip1`。

Zed 手动验证：

1. 需要 Rust/WASM 变更时重新 `Install Dev Extension`；只改语言服务器用 `scripts/deploy-local.ps1` + 重启语言服务器
2. 打开包含 locale 文件的前端项目
3. 测试 hover、completion、diagnostics、definition、references、code action
4. 查看 Zed 日志，确认 language server 无报错

发布流程见 `.agents/skills/zed-extension-release/SKILL.md`，推送 `v*` tag 触发 npm 发布。

---

## 不做事项

- 复杂 WebView UI
- 自动机器翻译或调用外部 LLM/API
- 大规模自动重构
- 执行用户 locale `.ts` 文件代码
- 一次性支持所有 i18n 框架

原则：先把核心 LSP 体验做稳，再逐步扩展。
