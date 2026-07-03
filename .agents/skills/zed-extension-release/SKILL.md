---
name: zed-extension-release
description: Release workflow for a Zed extension that has a Rust/WASM extension shell plus an npm language server. Use when bumping versions, updating public docs, publishing npm via GitHub tag workflow, deploying locally, or syncing the zed-industries/extensions PR/submodule entry.
---

# Zed Extension Release Workflow

Use this skill when the user wants to release a Zed extension similar to `yizixu/zed-i18n-lens`: a Zed Rust/WASM extension that installs a companion npm language server at runtime and is submitted to `zed-industries/extensions` as a submodule PR.

The workflow is designed to be careful and public-release oriented. Do not skip validation. Be explicit about what has been verified and what still needs reviewer action.

## Assumptions

- Main extension repository has:
  - `extension.toml`
  - `Cargo.toml`
  - `Cargo.lock`
  - `package.json`
  - `package-lock.json`
  - `README.md`
  - optional `ROADMAP.md`
  - `.github/workflows/release.yml` that publishes npm on `v*` tag push
- npm package is published from the main repository.
- `zed-industries/extensions` fork/PR is in a separate local repo, often `E:/code/extensions`.
- Extension entry in `zed-industries/extensions` may be a git submodule/gitlink under `extensions/<extension-id>` plus an entry in outer `extensions.toml`.

Adjust paths if the project differs.

## Safety Rules

1. Never publish before versions, docs, and tests are consistent.
2. Never use broad version replacement in `Cargo.lock`; only update the project package block.
3. Do not change unrelated files.
4. Preserve existing file style and line endings where possible. If tools introduce large formatting diffs, restore minimal diffs before committing.
5. If npm local auth is missing, do not block if the repository has a known GitHub Actions release workflow with npm provenance/token configured. Verify the workflow succeeds after pushing the tag.
6. For `zed-industries/extensions`, update both:
   - submodule/gitlink pointer, if the extension is registered as a submodule
   - outer `extensions.toml` version entry
7. After pushing the PR branch, check GitHub PR status checks and fix failures before reporting done.

## Release Checklist

### 1. Inspect current state

Run:

```bash
git --no-pager status --short
git --no-pager diff --stat
```

Check current versions:

```bash
node -p "require('./package.json').version"
grep -n '^version' extension.toml Cargo.toml
```

Search existing version references carefully:

```bash
grep -n "0\.x\.y" package.json package-lock.json extension.toml Cargo.toml Cargo.lock README.md ROADMAP.md 2>/dev/null || true
```

Use actual current and target versions.

### 2. Update public docs before release

Review `README.md` as if it will be read by users worldwide:

- Add or update Installation / Quick start.
- Show correct Zed settings path, normally:

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

- Explain project config file, e.g. `.zed/i18nlensrc.json`, and precedence:

```text
default config < Zed settings < project config
```

- Explain locale discovery rules, including nested paths like `src/i18n/locales/en-US.json` requiring `localeDirs: ["src/i18n/locales"]`.
- Document limitations honestly.
- Keep examples internationally understandable. Prefer `en-US`, `ja-JP`, `zh-CN` examples rather than only Chinese defaults, unless the extension intentionally defaults to Chinese.
- Update `ROADMAP.md` if present: current status, test count, released milestone, next priorities.

### 3. Bump versions

Update these files to the target version:

- `package.json`
- `package-lock.json`
- `extension.toml`
- `Cargo.toml`
- project package block in `Cargo.lock`

For `Cargo.lock`, only replace this block:

```toml
[[package]]
name = "<project-package-name>"
version = "old.version"
```

Do not replace dependency versions such as `tinystr`, `yoke`, `litemap`, etc.

### 4. Validate before commit

Run:

```bash
npm test
cargo check --target wasm32-wasip1
npm pack --dry-run
```

Optional whitespace check with CRLF-aware config if the repo uses CRLF:

```bash
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol --no-pager diff --check
```

Confirm npm target version does not already exist:

```bash
npm view <npm-package-name>@<target-version> version
```

Expected result for a new version is `E404 No match found`.

If local npm auth fails (`npm whoami` 401), check whether `.github/workflows/release.yml` publishes on `v*` tags. If yes, proceed via tag workflow and verify it completes.

### 5. Commit release changes

Use the user's commit-message convention. For this user, Chinese commit messages in `type: subject` format are preferred.

Example:

```bash
git add <changed-files>
git -c user.name=yizixu -c user.email=24697292+yizixu@users.noreply.github.com commit -m "feat: 支持 Zed settings 配置"
```

For pure release/version changes, examples:

```text
release: 发布 0.9.0
update: 同步发布文档
```

Use the message that best matches the actual changes.

### 6. Push main and tag

```bash
git push origin main
git tag v<target-version>
git push origin v<target-version>
```

If the tag already exists locally or remotely, stop and inspect before deleting or force-pushing.

### 7. Verify release workflow and npm publication

Use GitHub CLI when available:

```bash
gh run list --repo <owner>/<repo> --workflow Release --limit 3
gh run watch <run-id> --repo <owner>/<repo> --exit-status
```

Then verify npm:

```bash
npm view <npm-package-name>@<target-version> version
```

Expected output:

```text
<target-version>
```

### 8. Deploy locally for manual testing

If the repository has a local deployment script such as `scripts/deploy-local.ps1`, run it after release:

```bash
rm -rf C:/Users/<user>/AppData/Local/Zed/extensions/work/<extension-id>/node_modules/<npm-package-name>
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/deploy-local.ps1
```

Verify deployed package:

```bash
node -p "require('C:/Users/<user>/AppData/Local/Zed/extensions/work/<extension-id>/node_modules/<npm-package-name>/package.json').version"
```

Tell the user:

- For npm language server changes: run `restart language server` in Zed.
- For Rust/WASM extension changes: run `Install Dev Extension` again or restart Zed, because only restarting the language server may not reload the WASM extension.

## Sync `zed-industries/extensions` PR

Use this when an existing PR adds/updates the extension in `zed-industries/extensions`.

### 1. Inspect external extensions repo

If the repo is outside the current project root, use `git -C` from the current project directory:

```bash
git -C E:/code/extensions --no-pager status --short
git -C E:/code/extensions branch --show-current
git -C E:/code/extensions --no-pager grep -n "<extension-id>"
```

Confirm the PR branch, e.g. `add-i18n-lens`.

### 2. Update submodule/gitlink

If `extensions/<extension-id>` is a git submodule/gitlink, update it to the release commit:

```bash
git -C E:/code/extensions/extensions/<extension-id> reset --hard
git -C E:/code/extensions/extensions/<extension-id> fetch origin main
git -C E:/code/extensions/extensions/<extension-id> checkout <release-commit-sha>
```

Then inspect outer diff:

```bash
git -C E:/code/extensions --no-pager status --short
git -C E:/code/extensions --no-pager diff --submodule
```

### 3. Update outer registry version

Find the outer registry entry:

```bash
git -C E:/code/extensions --no-pager grep -n "<extension-id>\|<old-version>"
```

Usually update `extensions.toml`:

```toml
[<extension-id>]
submodule = "extensions/<extension-id>"
version = "<target-version>"
```

If this is not updated, CI may fail with:

```text
Error: Incorrect version for extension <extension-id>
Expected version: <old-version>
Actual version: <target-version>
```

### 4. Commit and push PR branch

```bash
git -C E:/code/extensions add extensions/<extension-id> extensions.toml
git -C E:/code/extensions -c user.name=yizixu -c user.email=24697292+yizixu@users.noreply.github.com commit -m "update: 同步 <extension-id> <target-version>"
git -C E:/code/extensions push origin <pr-branch>
```

If push is rejected, fetch and rebase:

```bash
git -C E:/code/extensions fetch origin <pr-branch>
git -C E:/code/extensions rebase origin/<pr-branch>
git -C E:/code/extensions push origin <pr-branch>
```

Resolve conflicts carefully; do not overwrite unrelated upstream changes.

### 5. Verify PR checks

```bash
gh pr view <pr-number> --repo zed-industries/extensions --json url,headRefName,reviewDecision,state,statusCheckRollup
```

Wait for checks:

- `package`: success
- `danger`: success
- `verification/cla-signed`: success

If a check fails, inspect logs:

```bash
gh run view <run-id> --repo zed-industries/extensions --job <job-id> --log
```

Fix the root cause and push again.

Note that `reviewDecision: CHANGES_REQUESTED` means checks can be green but a human reviewer still needs to re-review.

## Final Report Format

When done, report concisely:

- Main repo commit SHA and tag.
- npm package/version confirmed.
- Validation commands run and results.
- Local deployment status if performed.
- `zed-industries/extensions` PR URL and check status.
- Any remaining human action, such as reviewer re-review.

Example:

```text
Published v0.9.0.

- Main repo: 62e6c3b, tag v0.9.0
- npm: i18n-lens-language-server@0.9.0 confirmed
- Validation: npm test passed, cargo check passed, npm pack --dry-run passed
- Extensions PR: https://github.com/zed-industries/extensions/pull/6376
- Checks: package/danger/CLA all success
- Remaining: PR still has CHANGES_REQUESTED; needs reviewer re-review
```
