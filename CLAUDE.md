# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Zed extension that shows the real translation text behind i18n keys (inlay hints, hover, diagnostics, completion, definition, references) for Vue/TS/TSX/JS. It has **two parts**:

- **Rust/WASM extension shell** (`src/lib.rs`) — the thin adapter Zed loads. It does not do i18n analysis. Its job is to install the language server npm package at runtime (`npm_package_latest_version` / `npm_install_package` for `i18n-lens-language-server`), launch it over stdio, and bridge Zed settings (`lsp.i18n-lens.settings`) into LSP `initializationOptions` / workspace configuration.
- **Node.js language server** (`server/`) — where all real logic lives. Published to npm as `i18n-lens-language-server`; in production Zed downloads it, so `src/lib.rs` and `server/` are versioned and released together.

The `languages` list in `extension.toml` controls which buffers Zed attaches the server to (currently `Vue.js, TypeScript, TSX, JavaScript, JSON, JSONC`). A feature that must fire inside a file type (e.g. Find References from a `.json` locale file) **only works if that language is registered here** — the LSP handler is never reached otherwise.

## Server architecture (`server/`)

The split between the two server files is deliberate and should be preserved:

- **`server/core.js` — pure functions, no I/O.** Key extraction from source (`extractI18nKeys` and its regex/paren-balancing helpers), locale flattening, key↔position mapping (`findJsonKeyLocation`, `findLocaleKeyLocation`, `localeKeyAtPosition`, `findCodeKeyRanges`), diagnostics, inlay hints, completions, config normalization/merge. **All tests target this file.** New behavior should be implemented here as a testable pure function wherever possible.
- **`server/index.js` — LSP wiring + all filesystem/state.** Connection handlers, config loading, `fs.watchFile` watchers, debounced reloads, locale caching, monorepo project-context resolution, and directory walking (e.g. `collectSourceFiles` for Find References). It imports pure helpers from `core.js` and adds the I/O around them.

### Config precedence (three layers, low → high)

```
DEFAULT_CONFIG  <  Zed settings (lsp.i18n-lens.settings)  <  .zed/i18nlensrc.json
```

`mergeI18nLensConfig` merges the raw objects (Zed settings as base, project file as override; `inlayHints` deep-merged), then `normalizeI18nLensConfig` validates. Merge before normalize — never merge normalized defaults, or they clobber lower layers. `packages` entries in config create additional monorepo project contexts, each with its own `localeDirs`/`defaultLocale`, selected by longest-matching root.

### Locale loading nuance

A locale can be a single flat JSON file or a directory of files. Keys from nested files under a locale directory get **prefixed by the file stem** (`common.json` → `common.*`, except `index`). `lookupKeyForLocaleFile` encapsulates stripping that prefix, and `localeKeyAtPosition` restores it — key/location logic is precise for JSON and best-effort (line-based) for TS/JS locale modules. Keep both directions consistent when touching this.

## Commands

```bash
npm test                                    # all tests (node --test)
node --test tests/core.test.js              # same suite; single file
node --test --test-name-pattern "Find"      # run tests matching a name
cargo check --target wasm32-wasip1          # verify the WASM shell builds
```

Run **both** `npm test` and the `cargo check` after changes (the project convention, also in `ROADMAP.md`). On Windows the cargo binary is at `"$HOME/.cargo/bin/cargo.exe"`.

## Local iteration in Zed

`scripts/deploy-local.ps1` `npm pack`s the current working tree (uncommitted changes included) and installs it into Zed's extension work dir — then run **"restart language server"** in Zed. This only updates the server JS.

**Changes to `extension.toml` or `src/lib.rs` are NOT picked up by `deploy-local.ps1`** — they require reinstalling the dev extension in Zed ("install dev extension"), which may re-fetch the published npm server, so re-run `deploy-local.ps1` afterward.

## Releasing

Use the `zed-extension-release` skill (`.agents/skills/zed-extension-release/SKILL.md`) — it is the source of truth for the release flow, including the `CHANGELOG.md` gap check. Key points:

- A version bump touches **five files**: `extension.toml`, `Cargo.toml`, `Cargo.lock` (only the `zed-i18n-lens` package block — never blanket-replace, it hits dependency versions), `package.json`, `package-lock.json`.
- `CHANGELOG.md` (Keep a Changelog, English, newest-first) must have an entry for every version that ever appears in `extension.toml` history — verify no gaps before releasing.
- Release is driven by pushing a `v*` tag; `.github/workflows/release.yml` runs `npm publish`. The extension is also submitted to `zed-industries/extensions` as a submodule PR.

## Conventions

- Commit messages: Chinese, conventional-commit `type: subject` (e.g. `feat: ...`, `docs: ...`). Do **not** add a `Co-Authored-By: Claude` trailer in this repo.
- Files use CRLF line endings; git may warn on LF→CRLF — expected, not an error.
- The extension id is `i18n-lens` (Zed) and the npm package is `i18n-lens-language-server`; only the internal Cargo crate/repo may contain `zed` (Zed publishing rule forbids it in the extension/package names).
