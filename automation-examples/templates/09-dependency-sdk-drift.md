# Detect dependency and SDK drift; propose alignment.

ID: `dependency-sdk-drift`
Mode: `worktree`
Icon: `checkmark-circle`

Card preview:

Detect dependency and SDK drift and propose a minimal alignment plan.

Full automation prompt:

```
Detect dependency and SDK drift and propose a minimal alignment plan.

Grounding rules:
- Cite current and target versions from the repo when possible (lockfiles, package manifests).
- Do not guess versions; if targets are unclear, propose options and label them as suggestions.
```

Source message ids:

- home.useCases.dependencySdkDrift.prompt
- home.useCases.dependencySdkDrift.automationPrompt
