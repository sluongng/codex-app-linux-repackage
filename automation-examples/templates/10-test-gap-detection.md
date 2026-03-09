# Find test gaps from recent changes; create draft PRs.

ID: `test-gap-detection`
Mode: `worktree`
Icon: `puzzle`

Card preview:

Identify untested paths from recent changes; add focused tests and use $yeet for draft PRs.

Full automation prompt:

```
Identify untested paths from recent changes; add focused tests and use $yeet for draft PRs.

Constraints:
- Keep scope tight to the changed areas; avoid broad refactors.
- Prefer small, reliable tests that fail before and pass after.
```

Source message ids:

- home.useCases.testGapDetection.prompt
- home.useCases.testGapDetection.automationPrompt
