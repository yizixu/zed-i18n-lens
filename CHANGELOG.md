# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning while it is developed locally.

## [0.11.1] - 2026-07-23

### Changed

- Renamed the Zed extension id from `i18n-lens` to `i18n-lens-language-server` per the extension publishing prerequisites (extensions that only wrap a language server must suffix their id with `-lsp` or `-language-server`). The `[language_servers.i18n-lens]` id and the `lsp.i18n-lens.settings` namespace are unchanged.
- Bumped extension/package/Cargo version from `0.11.0` to `0.11.1`.

## [0.11.0] - 2026-07-06

### Added

- Diagnostics for cross-locale param inconsistency: warn when a key's interpolation params differ across languages (e.g. `en-US` has `{name}` but `zh-CN` forgot it). Surfaced both on the locale files (at the key) and at each source usage site. Backed by the new `getLocaleParamConsistency` / `getLocaleParamDiagnostics` core helpers.
- Quick fix: remove unused interpolation params from a supported i18n call, rebuilding the params object while keeping the params that are still used.
- Quick fix: create a missing i18n key (empty value) in every locale file that lacks it, as a cross-file workspace edit. Backed by the new `insertNestedJsonKey` core helper, which surgically inserts a dotted key and preserves the file's indentation. Only single flat JSON locale files are supported for now.

### Changed

- Bumped extension/package/Cargo version from `0.10.0` to `0.11.0`.

## [0.10.0] - 2026-07-03

### Added

- Find References: from a key in a locale file (JSON or TS/JS locale module) or from a source usage, list every place in the project's source code that uses the key. Works both directions; caret resolution reuses the same key/location logic as Go to Definition (precise for JSON, best-effort line-based for TS/JS locale modules).
- The language server now attaches to `JSON`/`JSONC` files so Find References can be invoked directly from `.json` locale files.
- Added `localeKeyAtPosition` and `findCodeKeyRanges` core helpers with tests.

### Changed

- Completion and inlay hints are now limited to source files, so editing JSON locale files no longer surfaces i18n key completions.
- Bumped extension/package/Cargo version from `0.9.0` to `0.10.0`.

## [0.9.0] - 2026-07-03

### Added

- Zed settings bridge: configure the extension directly from Zed settings under `lsp.i18n-lens.settings` (`defaultLocale`, `localeDirs`, `inlayHints`, `packages`), forwarded to the language server as LSP initialization options and workspace configuration. When both are present, `.zed/i18nlensrc.json` is merged on top of the Zed settings (project config wins), with `inlayHints` deep-merged. Settings changes apply live via `workspace/didChangeConfiguration`.
- Added `mergeI18nLensConfig` core helper with tests for combining Zed settings with project config.

### Changed

- Server update check now compares installed vs. latest versions numerically and only reinstalls when the installed server is actually older, instead of reinstalling on any string mismatch.
- Bumped extension/package/Cargo version from `0.8.3` to `0.9.0`.

## [0.8.3] - 2026-07-03

### Added

- Quick fix: add missing interpolation params to supported i18n calls (`t`/`$t`/`tc`/`$tc`, `formatMessage`), inserting the required param names into (or alongside) the params object.
- Added tests for the missing-params code action.

### Changed

- Bumped extension/package/Cargo version from `0.8.2` to `0.8.3`.

## [0.8.2] - 2026-06-30

### Added

- Diagnostics for interpolation params: report params that a call is missing versus the placeholders required by the locale text, and params passed but never used. Supports ICU-style `{name, plural, ...}` and simple `{name}` placeholders.
- Added tests for placeholder extraction and missing/unused param diagnostics.

### Changed

- Bumped extension/package/Cargo version from `0.8.1` to `0.8.2`.

## [0.8.1] - 2026-06-16

### Changed

- Fixed package metadata path format and hardened the release workflow with a published-version existence check to avoid republishing an existing version.
- Synced `Cargo.lock` to the bumped version and expanded README notes on enabling inline hints in Zed.
- Bumped extension/package/Cargo version from `0.8.0` to `0.8.1`.

## [0.8.0] - 2026-06-16

### Changed

- Distribution: the language server is now published to npm as `i18n-lens-language-server` and installed at runtime via the Zed Extension API (`npm_install_package`), instead of downloading a bundled `.cjs` from GitHub releases. This follows Zed's extension publishing prerequisites (extensions must not ship the language server, and package names must not contain `zed`). The release workflow now runs `npm publish` (needs an `NPM_TOKEN` secret).

## [0.7.0] - 2026-06-12

### Added

- Recognize more i18n call sites: Vue I18n plural `tc`/`$tc`, the `<i18n-t keypath="...">` component, react-i18next `<Trans i18nKey="...">`, and react-intl `formatMessage({ id: "..." })`. Hover, inlay hints, diagnostics, completion, and definition all work on these too.

### Changed

- Bumped extension/package/Cargo version from `0.6.0` to `0.7.0`.

## [0.6.0] - 2026-06-10

### Changed

- Go to Definition on an i18n key now returns every locale that defines it (default locale first) instead of only the default locale, so Ctrl/Cmd+click or F12 lets you jump straight to any language's source file. Hover stays a read-only translation table.

## [0.5.1] - 2026-06-10

### Changed

- Moved project config from `.i18nlensrc.json` to `.zed/i18nlensrc.json` because the extension has not been merged upstream yet and does not need legacy path compatibility.
- Moved the example config template to `.zed/i18nlensrc.example.json`.
- Bumped extension/package/Cargo version from `0.5.0` to `0.5.1`.

## [0.5.0] - 2026-06-07

### Added

- Added monorepo package contexts through `.i18nlensrc.json` `packages` entries.
- Added longest-prefix package root selection so files in `apps/web` and `packages/*` use their own locale directories and default locales.
- Added tests for monorepo config normalization and package context resolution.

### Changed

- Bumped extension/package/Cargo version from `0.4.0` to `0.5.0`.
- Locale discovery is now context-aware: package `localeDirs` are resolved relative to the selected package root instead of always using the workspace root.

## [0.4.0] - 2026-06-06

### Added

- Added diagnostics warnings for keys that exist in at least one locale but are missing from other loaded locales.
- Added file watchers for loaded locale files and locale directories so diagnostics and inlay hints refresh after translation files change.
- Fixed definition jumps to prefer the configured `defaultLocale`, including aliases such as `ZH` resolving to `zh-CN`, before falling back to other locales.
- Added diagnostic metadata for missing locale names and whether a key is missing from all locales.
- Added tests for full missing-key errors, partial locale warnings, complete locale coverage, empty locale caches, and default-locale-aware definition ordering.

### Changed

- Bumped extension/package/Cargo version from `0.3.0` to `0.4.0`.

## [0.3.0] - 2026-06-06

### Added

- Added `.i18nlensrc.json` project configuration support.
- Added configurable `defaultLocale` for completion details and inline translation hints.
- Added configurable `localeDirs` for workspace locale discovery.
- Added configurable `inlayHints.enabled` and `inlayHints.maxLength` options.
- Added `.i18nlensrc.example.json` as a copyable project config template.
- Added config normalization tests for defaults, overrides, invalid values, and disabling inlay hints.
- Added automatic `.i18nlensrc.json` file watching so config changes apply without rebuilding the extension.
- Added debounce-based project reload that refreshes config, locale cache, diagnostics, and inlay hints after config file changes.
- Added tests for watched-file change detection.
- Added default locale alias matching, including case-insensitive names, `_`/`-` normalization, and language-only aliases such as `en` matching `en-US`.
- Added full translation text tooltips for inline translation hints, even when the visible inline label is truncated.

### Changed

- Bumped extension/package version from `0.2.0` to `0.3.0`.
- The language server reloads `.i18nlensrc.json` on document save and when the config file changes on disk.
- Inline translation hints no longer set the LSP `Type` hint kind, so Zed classifies them as Other Hints instead of Type Hints.

## [0.2.0] - 2026-06-06

### Added

- Added LSP inlay hint support for inline i18n translations.
- Added `getInlayHints()` core helper with tests for:
  - default-locale inline translation labels
  - missing-key suppression
  - long translation truncation
  - range-filtered hint responses
- Added README documentation for inline translation behavior and local Zed testing.

### Changed

- Bumped extension/package version from `0.1.0` to `0.2.0`.
- Updated extension description to emphasize inline translations.

## [0.1.0] - 2026-06-06

### Added

- Initial Zed extension scaffold.
- Node.js Language Server launched from the Zed Rust/WASM adapter.
- Explicit `--stdio` transport when starting the language server.
- Locale JSON discovery for:
  - `src/locales/*.json`
  - `src/i18n/*.json`
  - `locales/*.json`
  - `i18n/*.json`
- Hover support for showing all locale values for an i18n key.
- Diagnostics for keys missing from every locale file.
- Completion for existing i18n keys using the default locale text as detail.
- Definition support for jumping from source keys to locale JSON definitions.
- Core tests for flattening, key extraction, hover rendering, diagnostics, completion, JSON key location, and nested key lookup.
- Project roadmap in `ROADMAP.md`.
