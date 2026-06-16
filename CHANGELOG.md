# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning while it is developed locally.

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
