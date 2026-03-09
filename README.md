# Codex App Linux Repacker

This project repackages the upstream macOS Codex desktop app so it can run on Linux. It does not scrape the DMG directly by default. Instead it reads the upstream Sparkle appcast feed, downloads the versioned macOS ZIP, inspects the bundled Electron version, rebuilds the native Node modules for Linux, and drops the result into a Linux Electron runtime.

## Why this approach

The current upstream app exposes a machine-readable release feed at `https://persistent.oaistatic.com/codex-app-prod/appcast.xml`. That feed points to versioned macOS ZIP artifacts such as `Codex-darwin-arm64-26.305.950.zip`, which are simpler to automate against than the generic `Codex.dmg` URL.

The builder keeps the upstream `app.asar` intact and only swaps native artifacts at paths that are already indexed by `app.asar`. That avoids having to repack the archive and accidentally break unpacked helper binaries like `node-pty`'s `spawn-helper`.

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

Install the current build as a desktop app for the current user:

```bash
npm run install-desktop -- --version 26.305.950
```

Build a specific upstream release:

```bash
npm run repackage -- --version 26.305.950
```

Build from a local upstream ZIP:

```bash
npm run repackage -- --zip /path/to/Codex-darwin-arm64-26.305.950.zip
```

Replace an existing output directory:

```bash
npm run repackage -- --force
```

Smoke-test a specific build output:

```bash
npm run smoke-test -- --version 26.305.950
```

The build output contains:

- `start.sh`: Linux launch script
- `serve-webview.mjs`: local static server for the extracted renderer assets
- `content/webview/`: renderer assets extracted from `app.asar`
- `resources/codex`: wrapper that resolves a Linux `codex` CLI
- `resources/rg`: wrapper that resolves Linux `rg`
- `codex-linux-manifest.json`: captured upstream and build metadata

## Notes

- The upstream bundle currently ships native modules for `better-sqlite3` and `node-pty`. The builder discovers those from `app.asar.unpacked` and rebuilds them for the Linux Electron runtime.
- `start.sh` launches a local HTTP server for the extracted `webview/` assets on `127.0.0.1:5175` before starting Electron, then tears that server down when the app exits.
- `npm run smoke-test` verifies the rebuilt native modules are Linux ELFs and that `start.sh` brings the local renderer up and back down cleanly.
- `npm run install-desktop` copies a built bundle into `~/.local/opt/codex-app/<version>/`, stages a desktop icon from the bundled assets, pins the discovered system `codex` and `rg` paths into a desktop launcher, defaults that launcher to its own `~/.local/share/codex-app/profile` user-data-dir to avoid singleton collisions, and writes `~/.local/share/applications/codex-app.desktop`.
- The upstream macOS resource executables `Resources/codex` and `Resources/rg` are replaced with Linux wrappers instead of attempting to run the macOS binaries.
- The project intentionally keeps downloads in `.cache/` and build outputs in `out/`.
