# codex-linux-extension-host

Prototype Linux native messaging host for the Codex Chrome extension.

It has two modes:

- `native-host`: launched by Chrome through Native Messaging. It bridges the
  Codex Chrome extension to a user-owned Unix socket. Running the binary with
  no subcommand defaults to this mode, matching how Chrome invokes manifest
  paths.
- CLI commands such as `tabs`, `history`, `cdp`, and `navigate`: called by
  Codex or a shell. They connect to the Unix socket and send JSON-RPC requests
  to the extension.

## Install

```bash
make install-local
make install-manifest
```

Then install or enable the Codex Chrome extension in Chrome. The extension ID is
`hehggadaopoacecdllhhajmbjkdcmajg`, and the native host name is
`com.openai.codexextension`.

## JSON policy

All successful read commands return JSON objects or arrays from the extension.
`doctor --json` returns a stable object with `ok`, `checks`, and `paths`.
Errors under `--json` use this shape:

```json
{"ok":false,"error":"message"}
```

Raw pass-through is available with:

```bash
codex-linux-extension-host --json request getInfo --no-session
```

Write-like commands such as `create-tab`, `claim-tab`, `attach`, `detach`,
`navigate`, and `turn-ended` perform the named action only.

## Examples

```bash
codex-linux-extension-host --json doctor
codex-linux-extension-host --json tabs --session demo --turn manual
codex-linux-extension-host --json navigate https://example.com --session demo --turn manual
```
