# Check CI failures; group likely root causes.

ID: `ci-monitor`
Mode: `worktree`
Icon: `terminal`

Card preview:

Check CI failures; group by likely root cause and suggest minimal fixes.

Full automation prompt:

```
Check CI failures; group by likely root cause and suggest minimal fixes.

Grounding rules:
- Cite jobs, tests, errors, and log evidence.
- Avoid overconfident root-cause claims; label uncertain items as “Suspected.”
```

Source message ids:

- home.useCases.ciMonitor.prompt
- home.useCases.ciMonitor.automationPrompt
