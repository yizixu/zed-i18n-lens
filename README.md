# I18n Lens for Zed

Zed extension plus Language Server for Vue, TypeScript, TSX, JavaScript and JSX. It shows the real translation text behind i18n keys while editing.

## Features

- Inline translation display via LSP inlay hints
- Detect `$t`/`t`/`tc`/`$tc`/`i18n.t` calls, `v-t="'key'"`, `v-t="{ path: 'key' }"`, `<i18n-t keypath="key">` (Vue I18n), `<Trans i18nKey="key">` (react-i18next), and `formatMessage({ id: "key" })` (react-intl)
- Hover: show all locale values for a key
- Diagnostics: report keys missing from every locale file as errors and keys missing from some locales as warnings
- Completion: suggest existing i18n keys with default locale text
- Definition: jump from a source key to its locale definition; when several locales define the key, pick which language file to open

## Inline translations

When inlay hints are enabled in Zed, code like this:

```ts
t("order.pay_now")
```

will show the default locale translation inline after the key string, for example:

```ts
t("order.pay_now")  立即支付
```

The inline hint uses `defaultLocale` from `.zed/i18nlensrc.json`, falling back to `zh-CN`. Missing keys are not shown inline because diagnostics already report them.

Long translations are truncated inline to keep the editor readable. Hover still shows the full locale table.

## Hover

Hovering over an i18n key shows every loaded locale value in a read-only table.

To open a specific language file, use Go to Definition (Ctrl/Cmd+click or F12) on the key. When the key exists in more than one locale, the editor offers each language's file — default locale first — so you can jump straight to the one you want instead of only the default locale.

## Diagnostics

Diagnostics refresh automatically when loaded locale files or locale directories change, so editing translation files should update warnings/errors without restarting the extension.

Diagnostics distinguish between two missing-key cases:

- If a key is missing from every loaded locale, it is reported as an error.
- If a key exists in at least one locale but is missing from other locales, it is reported as a warning listing the missing locale names.

For example, if `order.pay_now` exists in `zh-CN` but is missing from `en-US`, the warning message is:

```text
Missing i18n key "order.pay_now" in locales: en-US
```

## Project configuration

You can add `.zed/i18nlensrc.json` under your project root to override the defaults:

```json
{
  "defaultLocale": "zh-CN",
  "localeDirs": ["src/locales", "src/i18n", "locales", "i18n"],
  "inlayHints": {
    "enabled": true,
    "maxLength": 24
  },
  "packages": [
    {
      "root": "apps/web",
      "defaultLocale": "zh-CN",
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

A template is available in this repository:

```text
.zed/i18nlensrc.example.json
```

Supported options:

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultLocale` | string | `zh-CN` | Locale used for completion details and inline translation hints. Supports exact names such as `en-US`, case-insensitive matching, `_`/`-` normalization, and language aliases such as `en` matching `en-US`. |
| `localeDirs` | string[] | `src/locales`, `src/i18n`, `locales`, `i18n` | Workspace-relative directories to scan for locale files. |
| `inlayHints.enabled` | boolean | `true` | Enables or disables inline translation hints from this language server. |
| `inlayHints.maxLength` | number | `24` | Maximum inline hint label length before truncation. |
| `packages` | array | `[]` | Optional monorepo package contexts. Each item needs a workspace-relative `root` and can override `defaultLocale`, `localeDirs`, and `inlayHints`. The language server picks the longest package root matching the currently edited file. |

Invalid or missing config values fall back to defaults. If `.zed/i18nlensrc.json` contains invalid JSON, the language server logs a warning and continues with default config.

Configuration changes are watched automatically. After saving `.zed/i18nlensrc.json`, the language server reloads config, rebuilds the locale cache, refreshes diagnostics, and asks the editor to refresh inlay hints. You should not need to rebuild or reload the Zed extension just to apply config changes.

## Locale discovery

In a single-project workspace, `localeDirs` are resolved relative to the workspace root. The language server currently reads JSON files from:

- `src/locales/*.json`
- `src/i18n/*.json`
- `locales/*.json`
- `i18n/*.json`

Locale name comes from filename, for example `zh-CN.json` or `en-US.json`.

It also supports locale directories such as:

```text
src/locales/zh-CN/common.json
src/locales/en-US/common.json
```

A file named `common.json` contributes keys with the `common.` prefix. A file named `index.json` contributes keys without an `index.` prefix.

## Monorepo workspaces

For pnpm/turborepo and other monorepos, put `.zed/i18nlensrc.json` under the workspace root and add `packages` entries:

```json
{
  "defaultLocale": "zh-CN",
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

When a document is opened, I18n Lens selects the package whose `root` is the longest path prefix of that document. `localeDirs` inside a package are resolved relative to that package root, so `apps/web/src/locales` and `packages/admin/src/i18n` are indexed independently. Package entries inherit root-level `defaultLocale`, `localeDirs`, and `inlayHints` unless they override them.

## Local development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

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

If inline translations do not appear, check whether inlay hints are enabled in Zed settings.

### Iterating on the language server

The published npm version can lag behind your working tree. To test local `server/*.js` changes without publishing, pack the current tree and install it into the Zed work directory, then restart the server:

```powershell
./scripts/deploy-local.ps1
```

It runs `npm pack`, installs the tarball into `%LOCALAPPDATA%\Zed\extensions\work\i18n-lens\node_modules\i18n-lens-language-server` (the same layout Zed produces), then prompts you to run **restart language server** from the Zed command palette.

> To exercise the real install path instead, delete `%LOCALAPPDATA%\Zed\extensions\work\i18n-lens\node_modules` and restart the server — Zed will reinstall the published npm package.

## Releasing

The version is single-sourced across `Cargo.toml`, `extension.toml`, and
`package.json` (they must all match — the release workflow enforces this). To
cut a release:

1. Bump `version` in `Cargo.toml`, `extension.toml`, and `package.json`.
2. Tag and push:

   ```bash
   git tag v<version>   # e.g. v0.7.0
   git push origin v<version>
   ```

   The `.github/workflows/release.yml` workflow then verifies the versions
   match, runs the tests, and publishes the language server to npm as
   `i18n-lens-language-server`. This requires an `NPM_TOKEN` repository secret
   with publish rights.

   To publish manually instead: `npm publish --access public`.
3. Submit/update the extension in `zed-industries/extensions` (bump the
   `version` in its `extensions.toml` to match) so Zed picks up the new
   extension version, which installs the new npm package.
