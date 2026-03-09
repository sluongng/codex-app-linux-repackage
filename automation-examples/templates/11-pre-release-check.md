# Run a pre-release checklist before tagging.

ID: `pre-release-check`
Mode: `worktree`
Icon: `checkmark-circle`

Card preview:

Before tagging, verify changelog, migrations, feature flags, and tests.

Full automation prompt:

```
Before tagging, verify changelog, migrations, feature flags, and tests.

Grounding rules:
- Report ONLY what you can confirm from the repo and CI context.
- If a check cannot be verified, mark it explicitly as “Unknown.”
```

Source message ids:

- home.useCases.preReleaseCheck.prompt
- home.useCases.preReleaseCheck.automationPrompt
