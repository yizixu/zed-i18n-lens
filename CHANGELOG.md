# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning while it is developed locally.

## [0.15.0] - 2026-11-06

### Added

- Explicit Extract code actions for Vue/HTML template text and supported literal attributes. Extract replaces the source text with a `$t('key')` expression and adds a new entry to the preferred locale's JSON file. It works independently of optional raw-text diagnostics and does not extract ordinary JS/TS strings.
- Inline code actions for supported parameterless translation calls in Vue/HTML templates and JS/TS/JSX source, with one action per locale that defines the key. Inline inserts the locale's stored text, not a runtime-resolved translation.
- Regression coverage for attribute whitespace, quotes, entities and braces, JSX expressions, embedded HTML scripts, conflicting key prefixes, unsaved locale text, malformed JSON, and code-action exception isolation.

### Changed

- Extract avoids occupied key paths, including ancestor leaves, without unbounded suffix searches for an impossible prefix. Inline adds string-literal handling for braces in Vue/JSX text and withholds actions for partial attribute expressions.
- Extract and Inline failures are isolated from existing quick fixes and subsequent language requests. Multi-file edits still depend on the client's application and failure-handling behavior; rollback on permission errors is not guaranteed.
- Documented Extract/Inline usage and limitations. Rename remains separate and is tracked in [issue #2](https://github.com/yizixu/zed-i18n-lens/issues/2); Extract/Inline was contributed in [PR #4](https://github.com/yizixu/zed-i18n-lens/pull/4).
- Known release blocker: Inline can mistake a semicolonless JS/TS assignment for an HTML attribute, changing entity text or producing an invalid multiline string. Context detection and regression tests must be fixed before publishing `0.15.0`.
- Bumped extension/package/Cargo version from `0.14.0` to `0.15.0`.

## [0.14.0] - 2026-10-27

### Added

- Recursive locale directory discovery: JSON, TS, and JS files in nested directories map to namespaces from their relative path, so `locales/en/system/user.json` contributes `system.user.*` and `locales/en/system/forms/fields.ts` contributes `system.forms.fields.*`. An `index` file contributes to its parent namespace, so `locales/en/system/index.json` contributes `system.*`; a real `index/` directory contributes `index.*`.
- Nested locale files support inline translations, definition, references, and unsaved buffer updates.
- Locale files created in nested or still-empty directories are picked up automatically, and removing them restores the previous diagnostics, without restarting the language server.
- Missing-key quick fixes reuse an unambiguous sibling locale directory layout when the target file and its parent directory exist or can be created.

### Fixed

- TS and JS locale modules now keep the default export authoritative. A non-`index` module is no longer parsed as an `index` module, so file-local helper objects can no longer override default-export values or be reported as translations.
- A root `<locale>/index.json` is now distinguished from an `index/` namespace directory. Creating a missing key under `index.*` writes it into the namespace file instead of nesting another `index` object, and the root file is left untouched.
- Definition and declaration references now follow the file that actually supplied the winning value when several files define the same key, instead of preferring the file with the more specific namespace prefix.
- Overlapping `localeDirs` no longer create phantom locales. An explicitly configured nested root is excluded from its ancestor's scan regardless of configuration order or nesting depth, and a directory that holds no locale file no longer participates in missing-key diagnostics while it remains watched for new files.

### Changed

- Bumped extension/package/Cargo version from `0.13.0` to `0.14.0`.

## [0.13.0] - 2026-10-04

### Added

- Create missing keys in directory-based JSON locales, stripping the file-stem namespace correctly. Create missing namespace files only when an existing sibling-locale layout identifies the target and the client supports file creation.
- End-to-end stdio LSP regressions for locale editing, client edit capabilities, TS locale navigation, and package-isolated references.

### Fixed

- Locale reads now prefer open document contents and refresh on locale open/change/close. Quick fixes use versioned document edits, and key insertion emits a minimal edit instead of replacing the entire locale document.
- JSON definition lookup and key insertion now follow object boundaries, handle escaped and dotted property names, preserve CRLF, and reject duplicate properties, conflicting paths, and scalar/array prefixes rather than writing into the wrong object.
- Ignore i18n calls inside comments and ordinary strings, skip concatenated dynamic keys, and restrict completion to supported key contexts while retaining Vue, JSX, and template-literal expressions.
- Load top-level TS/JS locale modules without a locale-name prefix, and treat locale modules as definitions for references and parameter-consistency diagnostics rather than as source files.
- Keep references within the selected project/package context and include new unsaved source documents.
- Missing-key quick fixes are no longer dropped when the target locale file exists but is empty or whitespace-only: it is seeded like an empty object, keeping its line-ending style. Namespace targets that already exist on disk, or are open as an unsaved buffer, are edited in place instead of being skipped.

### Changed

- Quick fixes require client support for versioned document changes. Missing-key creation is withheld when any remaining locale target is ambiguous or unwritable; TS/JS module writes and JSONC locale files remain unsupported.
- Bumped extension/package/Cargo version from `0.12.0` to `0.13.0`.

## [0.12.0] - 2026-09-16

### Added

- Optional raw-text diagnostics for literal user-facing text in HTML documents and Vue single-file component templates. They detect likely natural-language text plus static `title`, `alt`, `placeholder`, `label`, and `aria-label` attributes; simple quoted literals on those bound attributes are also supported.
- Added the `rawTextDiagnostics` setting, disabled by default and available in Zed settings, `.zed/i18nlensrc.json`, and monorepo package overrides.
- Registered HTML buffers with I18n Lens so raw-text diagnostics work for standalone `.html` files as well as Vue templates.

### Changed

- Raw-text detection intentionally skips scripts, styles, comments, interpolations, translation components/directives, `code`/`pre`, and explicitly untranslated subtrees. It does not scan JavaScript, TypeScript, or JSX strings, and does not rewrite source files.
- Bumped extension/package/Cargo version from `0.11.1` to `0.12.0`.

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
