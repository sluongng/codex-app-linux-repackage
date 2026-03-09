# Scan outdated dependencies and propose safe upgrades.

ID: `dependency-sweep`
Mode: `worktree`
Icon: `block-stack, skills`

Card preview:

Scan outdated dependencies; propose safe upgrades with minimal changes.

Full automation prompt:

```
Scan outdated dependencies; propose safe upgrades with minimal changes.

Rules:
- Prefer the smallest viable upgrade set.
- Explicitly call out breaking-change risks and required migrations.
- Do not propose upgrades without identifying current versions from the repo.
```

Source message ids:

- home.useCases.dependencySweep.prompt
- home.useCases.dependencySweep.automationPrompt
