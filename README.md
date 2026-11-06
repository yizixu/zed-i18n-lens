# I18n Lens for Zed

Zed extension plus Language Server for Vue, TypeScript, TSX, JavaScript and JSX. It shows the real translation text behind i18n keys while editing.

## Features

- Inline translation display via LSP inlay hints
- Detect `$t`/`t`/`tc`/`$tc`/`i18n.t` calls, `v-t="'key'"`, `v-t="{ path: 'key' }"`, `<i18n-t keypath="key">` (Vue I18n), `<Trans i18nKey="key">` (react-i18next), and `formatMessage({ id: "key" })` (react-intl)
- Hover: show all locale values for a key
- Diagnostics: report missing keys, missing locale entries, mismatched interpolation params, and (on locale files) keys whose params differ across languages
- Optional raw-text diagnostics: flag likely untranslated Vue/HTML template text and selected user-facing attributes
- Quick fixes: add missing / remove unused interpolation params, and create missing keys in unambiguous JSON locale targets using versioned edits
- Extract / Inline code actions: explicitly extract Vue/HTML template text into a new locale key, or replace a supported translation call with one locale's stored text
- Completion: suggest existing i18n keys with default locale text only inside supported i18n key positions
- Definition: jump from a source key to its locale definition; when several locales define the key, pick which language file to open
- References: from a locale definition or source usage, find references within the same project/package context, including open source files not yet saved to disk
- Recursive locale directories: nested JSON, TS, and JS files map to dot-separated namespaces, with `index` files contributing to their parent namespace

## Installation

Install **I18n Lens** from Zed's extension catalog. The extension downloads its companion language server package, [`i18n-lens-language-server`](https://www.npmjs.com/package/i18n-lens-language-server), into Zed's extension work directory at runtime.

After installation, open a Vue, TypeScript, TSX, JavaScript, or JSX file in a project that contains locale files. If your locale files are not in one of the default directories, configure `localeDirs` as shown below.

## Quick start

For most projects, add this to your project `.zed/settings.json` or user-level Zed settings:

```json
{
  "lsp": {
    "i18n-lens": {
      "settings": {
        "defaultLocale": "en-US",
        "localeDirs": ["src/locales", "src/i18n"]
      }
    }
  }
}
```

If you prefer a project-owned config file that can be committed with the repository, create `.zed/i18nlensrc.json` instead. When both are present, `.zed/i18nlensrc.json` takes precedence over Zed settings.

## Inline translations

> **Important:** Inline translations are rendered through Zed's LSP inlay hints. In Zed settings, make sure **Inlay Hints** are enabled and **Inlay Hints: Show Other Hints** is turned on. If **Show Other Hints** is disabled, hover/completion/diagnostics can still work, but inline translation text will not be displayed.

When inlay hints are enabled in Zed, code like this:

```ts
t("order.pay_now")
```

will show the default locale translation inline after the key string, for example:

```ts
t("order.pay_now")  立即支付
```

The inline hint uses `defaultLocale` from your Zed settings or `.zed/i18nlensrc.json`, falling back to `zh-CN`. Missing keys are not shown inline because diagnostics already report them.

Long translations are truncated inline to keep the editor readable. Hover still shows the full locale table.

## Hover

Hovering over an i18n key shows every loaded locale value in a read-only table.

To open a specific language file, use Go to Definition (Ctrl/Cmd+click or F12) on the key. When the key exists in more than one locale, the editor offers each language's file — default locale first — so you can jump straight to the one you want instead of only the default locale.

## Diagnostics

Diagnostics refresh automatically when loaded locale files or locale directories change, so editing translation files should update warnings/errors without restarting the extension.

Open locale documents take precedence over disk contents. Opening, changing, or closing an existing locale file refreshes translations and diagnostics without requiring a save.

Diagnostics distinguish between these cases:

- If a key is missing from every loaded locale, it is reported as an error.
- If a key exists in at least one locale but is missing from other locales, it is reported as a warning listing the missing locale names.
- If a translation contains named placeholders such as `{count}` but the source call does not pass them, it reports missing params.
- If the source call passes params that no loaded translation uses, it reports unused params.
- Quick fixes can add missing params to supported i18n calls.

For example, if `order.pay_now` exists in `zh-CN` but is missing from `en-US`, the warning message is:

```text
Missing i18n key "order.pay_now" in locales: en-US
```

### Optional untranslated template text detection

Set `"rawTextDiagnostics": true` in `.zed/i18nlensrc.json` or under `lsp.i18n-lens.settings` to enable warnings with diagnostic code `raw-text`. It is **off by default**, works even without loaded locale files, and can be overridden per monorepo package.

```json
{
  "rawTextDiagnostics": true
}
```

This first version uses `htmlparser2` to inspect HTML documents and the top-level HTML `<template>` of Vue single-file components:

- Literal text such as `<button>Save changes</button>`.
- Static `title`, `alt`, `placeholder`, `label`, and `aria-label` attributes.
- Whole, unescaped quoted literals on those bound attributes, such as `:placeholder="'Enter name'"` or `v-bind:title="'Helpful title'"`. Variables, translation calls, concatenations, template literals and other expressions are not evaluated.

The natural-language heuristics are inspired by i18n Ally's raw-string detection, but this is **not full Ally parity**. They recognize multi-word phrases, title-cased labels and non-Latin text, while ignoring numbers, punctuation, URLs, paths and obvious identifier-like tokens. Lowercase single words, acronyms, text split across elements and ambiguous labels may be missed; names or technical phrases can still produce false positives. Warnings are suggestions, not proof that text must be translated.

Comments, `script`/`style`, Vue custom blocks, interpolations (`{{ ... }}`), translation-component subtrees (`i18n-t`/`I18nT`, legacy `i18n`, `Trans`) and `v-t` elements are excluded. `code`/`pre`, `v-pre`, `v-html`, `v-text` and `translate="no"` subtrees are also skipped; use `translate="no"` to mark intentionally untranslated content. Vue templates using `src` or a non-HTML `lang` (such as Pug) are not inspected.

Raw-text diagnostics do not analyze JavaScript/TypeScript/JSX strings, scan the whole workspace, or extract text automatically. Only open Vue/HTML buffers receive these warnings. Explicit Extract actions are available separately from the editor's code-action menu, even when these warnings are disabled (see below). The parser is tolerant of incomplete markup, not a full Vue compiler; complex or malformed templates can be missed. Existing key/parameter diagnostics and quick fixes are unchanged.

For local development, HTML registration in `extension.toml` requires reinstalling the dev extension in Zed, then running `scripts/deploy-local.ps1` again and restarting the language server. Updating only the server does not register HTML buffers.

## Creating missing keys safely

The missing-key quick fix supports a single JSON file per locale and directory layouts such as `locales/en/common.json`. For `t('common.submit')`, it inserts `submit` into `common.json`, without duplicating the `common.` prefix. `index.json` has no file-stem prefix.

- Edits use the current open document text and version, preserve unrelated content and line endings, and change only the necessary text rather than replacing the entire file.
- If a target namespace file is missing, the server can create it when another locale establishes the corresponding JSON namespace layout. It does not invent an unknown namespace layout or overwrite a file that appears after the action was requested.
- Ambiguous layouts (for example, both `common.json` and `common.ts`, overlapping index/namespace ownership including empty namespace objects, or multiple backing directories) do not receive a guessed edit. Invalid JSON, duplicate properties, and scalar/object path conflicts are also refused.
- A multi-locale diagnostic receives a creation action only when all remaining missing locales can be repaired safely. TS/JS module writes and JSONC locale loading/writes are not supported.
- Quick fixes require LSP `workspace.workspaceEdit.documentChanges` support. Creating a file additionally requires the `create` resource operation. Existing-file edits use the open document version, or `null` for closed files; the server cannot version-check external changes to closed files.

Recognition skips calls inside comments and ordinary strings, and does not treat a concatenated key such as `t('prefix.' + name)` as a static key. Vue directive expressions, JSX expressions, and calls inside template-literal interpolations remain supported. Recognition is lexical, not full framework binding or scope analysis.

## Extract and Inline code actions

These actions **rewrite source code**; they are separate from the read-only inline translation hints above. Open the editor's code-action menu at the text or call you want to change and review the proposed edits before applying them. Both actions require client support for `workspace.workspaceEdit.documentChanges`.

### Extract template text

In a Vue HTML `<template>` or an HTML document, place the caret in a supported static text fragment, or select a range that fully contains it, and choose **Extract to i18n key "…"**. A selection can offer separate actions for several fragments; it does not extract arbitrary substrings or apply a batch conversion. `rawTextDiagnostics` can remain disabled.

For example, in `Home.vue` with no existing source keys:

```html
<!-- Before -->
<button>Save changes</button>
<!-- After -->
<button>{{ $t('Home.save_changes') }}</button>
```

Extract also adds `"Home": { "save_changes": "Save changes" }` to the selected locale's JSON, preserving unrelated entries. It writes **only one locale**: the current project/package's `defaultLocale`, including locale-name normalization and language aliases, or the first loaded locale if none matches. No loaded locales means no Extract action. It does not create a missing default language or populate every translation.

- Supported attributes are `title`, `alt`, `placeholder`, `label`, and `aria-label`, including whole, simple quoted literals in bound attributes. Static attributes become bindings such as `:title="$t('Home.save_changes')"`. HTML files receive the same **Vue-style syntax**; this is not a framework-neutral HTML rewrite.
- Key prefixes come from nearby existing template keys, then a file-wide common parent prefix, then the filename stem. The suffix uses a short ASCII text slug or a deterministic hash for text without ASCII words. Every extraction allocates a new key rather than reusing identical text; conflicts in the selected locale can change the prefix or add a numeric suffix.
- Extract shares the template exclusions described under raw-text diagnostics. It does not extract ordinary JS/TS/JSX strings, evaluate dynamic expressions, or turn interpolated text into parameterized messages. Fragments containing entities or `&`, `<`, `>`, `{`, or `}` are skipped, and repeated whitespace in the stored value is collapsed to a single space.
- Locale edits follow the JSON target rules in **Creating missing keys safely** above. Invalid JSON, duplicate properties, ambiguous layouts, conflicting paths, or TS/JS targets suppress the action. New namespace files additionally require client support for `create`, an established sibling-locale JSON layout, and an existing parent directory; Extract does not create directories.

### Inline a translation call

Place the caret or a selection inside a static-key call such as `t('Home.save_changes')` and choose an **Inline** action for the desired locale. One action is offered per loaded locale that defines the key. It changes only the source and leaves the locale entry intact.

Inline supports `t`, `$t`, `tc`, `$tc`, `i18n.t`, and `i18n.tc` calls with **only the key argument**, in Vue/HTML templates and JS/TS/JSX/TSX source. Passing any additional argument, even `{}`, suppresses the action. Other recognized forms such as `formatMessage`, `v-t`, or translation components are not supported by Inline. Partial quoted attribute expressions such as `:title="t('key') + suffix"` are skipped.

Inline uses context-dependent HTML/JS string escaping, retaining a string expression where needed for braces in Vue/JSX text. It is intended to insert the locale's **stored text**, not a resolved runtime message: `{name}`, plural forms, and linked messages are not evaluated. A call without extra arguments can still rely on runtime behavior, so check that replacing it with literal text is appropriate. Recognition is lexical, not full AST, scope, or framework analysis.

**Known bug — release blocker:** A plain JS/TS assignment without a semicolon, such as `const label = t('greet')`, can be misclassified as an HTML attribute. Inline can then double-escape entity text (`A &amp; B` becomes `A &amp;amp; B`) or insert an unescaped newline into a quoted string, producing invalid code. Avoid Inline in JS/TS assignment statements until this context-detection bug is fixed; this is not merely a runtime-message limitation.

### Editing and failure boundaries

Extract returns the source and locale changes in one LSP `WorkspaceEdit`; the editor applies them. Open buffers use their unsaved text and document version. Closed files have no version check against external changes. **Atomic application and rollback after permission or other client-side failures are not guaranteed or fully tested**; inspect both files if an edit fails. Failure while generating Extract or Inline actions is logged without discarding unrelated quick fixes.

Rename is not included in this release; it remains tracked in [issue #2](https://github.com/yizixu/zed-i18n-lens/issues/2).

## Project configuration

I18n Lens supports two configuration sources:

1. Zed settings, under `lsp.i18n-lens.settings`.
2. A project file, `.zed/i18nlensrc.json`.

The project file is merged on top of Zed settings, so repository-specific configuration can override personal or team-wide editor settings.

### Configure from Zed settings

Use this when you want configuration to live in Zed's normal settings system:

```json
{
  "lsp": {
    "i18n-lens": {
      "settings": {
        "defaultLocale": "en-US",
        "localeDirs": ["src/locales", "src/i18n"],
        "inlayHints": {
          "enabled": true,
          "maxLength": 32
        }
      }
    }
  }
}
```

Zed settings can be user-level or project-level. For project-level Zed settings, put the snippet in `.zed/settings.json`.

### Configure from `.zed/i18nlensrc.json`

Use this when the i18n layout should be part of the repository and shared by everyone who opens it:

```json
{
  "defaultLocale": "en-US",
  "localeDirs": ["src/locales", "src/i18n"],
  "inlayHints": {
    "enabled": true,
    "maxLength": 32
  },
  "packages": [
    {
      "root": "apps/web",
      "defaultLocale": "en-US",
      "localeDirs": ["src/locales"]
    },
    {
      "root": "packages/admin",
      "defaultLocale": "ja-JP",
      "localeDirs": ["src/i18n"]
    }
  ]
}
```

A template is available in this repository:

```text
.zed/i18nlensrc.example.json
```

Supported options:

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultLocale` | string | `zh-CN` | Preferred locale for Extract, completion details, and inline translation hints. Supports exact names such as `en-US`, case-insensitive matching, `_`/`-` normalization, and language aliases such as `en` matching `en-US`. |
| `localeDirs` | string[] | `src/locales`, `src/i18n`, `locales`, `i18n` | Workspace-relative directories to scan for locale files. In package configs, paths are relative to that package root. |
| `inlayHints.enabled` | boolean | `true` | Enables or disables inline translation hints from this language server. Hover, completion, definition, diagnostics, and quick fixes can still work when inline hints are disabled. |
| `inlayHints.maxLength` | number | `24` | Maximum inline hint label length before truncation. Hover still shows the full text. |
| `rawTextDiagnostics` | boolean | `false` | Opt-in warnings for likely untranslated Vue/HTML template text and selected attributes. No automatic extraction. |
| `packages` | array | `[]` | Optional monorepo package contexts. Each item needs a workspace-relative `root` and can override `defaultLocale`, `localeDirs`, `inlayHints`, and `rawTextDiagnostics`. The language server picks the longest package root matching the currently edited file. |

Invalid or missing config values fall back to defaults. If `.zed/i18nlensrc.json` contains invalid JSON, the language server logs a warning and continues with the Zed settings or default config.

Configuration changes are watched automatically. After saving `.zed/i18nlensrc.json`, the language server reloads config, rebuilds the locale cache, refreshes diagnostics, and asks the editor to refresh inlay hints. Changes made through Zed settings are also handled through the language server configuration update path.

## Locale discovery

In a single-project workspace, `localeDirs` are resolved relative to the workspace root. By default, the language server reads JSON files from these directories if they exist:

- `src/locales/*.json`
- `src/i18n/*.json`
- `locales/*.json`
- `i18n/*.json`

Locale names come from filenames, for example `en-US.json`, `ja-JP.json`, or `zh-CN.json`. If your files are under a nested directory such as `src/i18n/locales/en-US.json`, set `localeDirs` to `["src/i18n/locales"]`.

It also supports locale directories such as:

```text
src/locales/en-US/common.json
src/locales/ja-JP/common.json
```

A file named `common.json` contributes keys with the `common.` prefix. A file named `index.json` contributes keys without an `index.` prefix.

Locale directories are scanned recursively. Subdirectories contribute to the namespace:

```text
src/locales/en-US/system/user.json       -> system.user.*
src/locales/en-US/system/index.json      -> system.*
src/locales/en-US/system/forms/fields.ts -> system.forms.fields.*
src/locales/en-US/index/index.json       -> index.*
```

Nested JSON, TS, and JS locale files support translation previews, definition, references, and unsaved buffer updates. Adding files in nested directories refreshes translations automatically. Missing-key quick fixes retain the existing namespace directory layout when the target is unambiguous and its parent directory exists.

If `localeDirs` overlap, an explicitly configured nested root is excluded from its ancestor's recursive scan, regardless of configuration order or nesting depth. For example, with `["locales", "locales/modules/features"]`, `locales/modules/features/en/user.json` belongs to locale `en` with keys `user.*`, not locale `modules`. Intermediate directories without locale files are watched for new files but do not count as locales. Empty locale files still count as locales and report missing keys.

Top-level TS/JS modules such as `locales/en.ts` are also loaded, without adding an `en.` prefix. Directory modules such as `locales/en/common.ts` retain the `common.` prefix; `index.ts` has no file-stem prefix. Modules are parsed statically, never executed. Their definitions support Find References and cross-language parameter diagnostics, not source-code completions or inlay hints. TS/JS key positioning remains best-effort rather than a full syntax-tree analysis.

## Monorepo workspaces

For pnpm/turborepo and other monorepos, put `.zed/i18nlensrc.json` under the workspace root and add `packages` entries:

```json
{
  "defaultLocale": "en-US",
  "packages": [
    {
      "root": "apps/web",
      "localeDirs": ["src/locales"]
    },
    {
      "root": "packages/admin",
      "defaultLocale": "en-US",
      "localeDirs": ["src/i18n"]
    }
  ]
}
```

When a document is opened, I18n Lens selects the package whose `root` is the longest path prefix of that document. `localeDirs` inside a package are resolved relative to that package root, so `apps/web/src/locales` and `packages/admin/src/i18n` are indexed independently. Package entries inherit root-level `defaultLocale`, `localeDirs`, `inlayHints`, and `rawTextDiagnostics` unless they override them.

Find References excludes separately configured nested package roots and locale modules, so identical keys in independent packages are not mixed. The existing source scanner is bounded at approximately 5,000 files; its results are not a project-wide completeness guarantee for larger workspaces.

## Local development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

The suite covers pure-function behavior plus real stdio LSP sessions in temporary workspaces, including dirty locale buffers, namespace file creation, client capabilities, and package-isolated references.

The language server is published to npm as
[`i18n-lens-language-server`](https://www.npmjs.com/package/i18n-lens-language-server).
A Zed extension must not ship its language server, so the Rust shell installs
that npm package into its work directory at runtime via the Zed Extension API
(`npm_install_package`), the same pattern the official Node-based extensions use.

Check the Zed extension adapter:

```bash
cargo check --target wasm32-wasip1
```

On this Windows setup, if `cargo` is not visible inside Git Bash / WSL, use:

```bash
"$HOME/.cargo/bin/cargo.exe" check --target wasm32-wasip1
```

## Test in Zed

1. Open Zed.
2. Run `Install Dev Extension` from the command palette.
3. Select this project root, for example the local `zed-i18n-lens` repository directory.
4. Open a Vue/TS/JS project with locale JSON files.
5. Test hover, completion, diagnostics, definition, and inlay hints.

### Iterating on the language server

The published npm version can lag behind your working tree. To test local `server/*.js` changes without publishing, pack the current tree and install it into the Zed work directory, then restart the server:

```powershell
./scripts/deploy-local.ps1
```

It runs `npm pack`, installs the tarball into `%LOCALAPPDATA%\Zed\extensions\work\i18n-lens-language-server\node_modules\i18n-lens-language-server` (the same layout Zed produces), then prompts you to run **restart language server** from the Zed command palette.

> To exercise the real install path instead, delete `%LOCALAPPDATA%\Zed\extensions\work\i18n-lens-language-server\node_modules` and restart the server — Zed will reinstall the published npm package.


