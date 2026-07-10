# ChatGPT Desktop Linux Repacker

This project repackages the unified ChatGPT desktop app for Linux. OpenAI ships Chat, Work, and Codex together through the former Codex app's release channel. The repacker reads that Sparkle appcast, downloads the versioned macOS ZIP, inspects the bundled Electron version, rebuilds the native Node modules for Linux, and drops the result into a Linux Electron runtime.

## Why this approach

The current upstream app still exposes its machine-readable release feed at `https://persistent.oaistatic.com/codex-app-prod/appcast.xml`. That feed is the migration path from the Codex app to ChatGPT desktop and points to versioned macOS ZIP artifacts such as `ChatGPT-darwin-arm64-26.707.31428.zip`, which are simpler to automate against than the generic DMG URL.

The builder keeps the upstream app code mostly intact while applying narrow Linux compatibility changes: it rebuilds or replaces Linux native artifacts, injects missing Linux prebuilds for bundled dependencies when needed, and patches the avatar overlay behavior for Linux window managers.

## Prerequisites

- Linux
- Node.js and `npm`
- `unzip`
- `python3`
- `make`
- `g++`
- `codex` on `PATH` at runtime, or `CODEX_APP_SYSTEM_CODEX=/path/to/codex`
- `rg` on `PATH` at runtime, or `CODEX_APP_SYSTEM_RG=/path/to/rg`

## Usage

Install the project dependencies:

```bash
npm install
```

Inspect the latest upstream release:

```bash
npm run release-info
```

Build the latest Linux package into `out/`:

```bash
npm run repackage
```

Smoke-test the packaged app launch path:

```bash
npm run smoke-test
```

Extract the bundled Scheduled Task and automation UI metadata into a repo directory:

```bash
npm run extract-automation-examples -- --version 26.707.31428
```

Install the current build as a desktop app for the current user:

```bash
npm run install-desktop -- --version 26.707.31428
```

Build a specific upstream release:

```bash
npm run repackage -- --version 26.707.31428
```

Build from a local upstream ZIP:

```bash
npm run repackage -- --zip /path/to/ChatGPT-darwin-arm64-26.707.31428.zip
```

Replace an existing output directory:

```bash
npm run repackage -- --force
```

Smoke-test a specific build output:

```bash
npm run smoke-test -- --version 26.707.31428
```

The build output contains:

- `start.sh`: Linux launch script
- `serve-webview.mjs`: local static server for the extracted renderer assets
- `content/webview/`: renderer assets extracted from `app.asar`
- `resources/codex`: wrapper that resolves a Linux `codex` CLI
- `resources/rg`: wrapper that resolves Linux `rg`
- `codex-linux-manifest.json`: captured upstream identity and build metadata

## Notes

- `npm run extract-automation-examples` reads the compiled webview bundles from a built output and rewrites `automation-examples/` with the latest Scheduled Task metadata and any legacy automation template cards. The upstream app version stays inside the generated metadata files, so Git can track prompt changes without nesting by version.
- The upstream bundle currently ships native modules for `better-sqlite3` and `node-pty`. The builder discovers those from `app.asar.unpacked` and rebuilds them for the Linux Electron runtime. When bundled Work Louder device support is present, the builder also adds the missing Linux `node-hid` prebuilds to `app.asar`.
- `start.sh` launches a local HTTP server for the extracted `webview/` assets on `127.0.0.1:5175` before starting Electron, then tears that server down when the app exits.
- `npm run smoke-test` verifies the rebuilt native modules are Linux ELFs, checks that unified releases contain Chat, Work, and Codex renderer surfaces, and confirms that `start.sh` brings the local renderer up and back down cleanly.
- `npm run install-desktop` copies a built bundle into `~/.local/opt/codex-app/<version>/`, stages the ChatGPT icon from the bundled assets, pins the discovered system `codex` and `rg` paths into a desktop launcher, defaults that launcher to its existing `~/.local/share/codex-app/profile` user-data-dir to preserve authentication and history, registers the `codex:` URL scheme, and writes `~/.local/share/applications/codex-app.desktop`.
- `CHATGPT_APP_USER_DATA_DIR` and `CHATGPT_APP_OZONE_PLATFORM` are the public launcher overrides. Their legacy `CODEX_APP_*` equivalents remain supported for compatibility.
- Internal `codex-app`, `codex-linux-*`, `com.openai.codex`, and `codex:` names intentionally remain because OpenAI retained those identities in the unified ChatGPT release.
- The upstream macOS resource executables `Resources/codex` and `Resources/rg` are replaced with Linux wrappers instead of attempting to run the macOS binaries.
- The project intentionally keeps downloads in `.cache/` and build outputs in `out/`.
