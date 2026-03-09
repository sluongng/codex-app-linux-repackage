# Scan recent commits for likely bugs and propose minimal fixes.

ID: `daily-bug-scan`
Mode: `worktree`
Icon: `ladybug`

Card preview:

Scan recent commits (since the last run, or last 24h) for likely bugs and propose minimal fixes.

Full automation prompt:

```
Scan recent commits (since the last run, or last 24h) for likely bugs and propose minimal fixes.

Grounding rules:
- Use ONLY concrete repo evidence (commit SHAs, PRs, file paths, diffs, failing tests, CI signals).
- Do NOT invent bugs; if evidence is weak, say so and skip.
- Prefer the smallest safe fix; avoid refactors and unrelated cleanup.
```

Source message ids:

- home.useCases.dailyBugScan.prompt
- home.useCases.dailyBugScan.automationPrompt
