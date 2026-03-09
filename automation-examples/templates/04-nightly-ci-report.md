# Summarize CI failures and flaky tests.

ID: `nightly-ci-report`
Mode: `worktree`
Icon: `radar`

Card preview:

Summarize CI failures and flaky tests from the last CI window; suggest top fixes.

Full automation prompt:

```
Summarize CI failures and flaky tests from the last CI window; suggest top fixes.

Grounding rules:
- Cite specific jobs, tests, error messages, or log snippets when available.
- Avoid overconfident root-cause claims; separate “observed” vs “suspected.”
```

Source message ids:

- home.useCases.nightlyCiReport.prompt
- home.useCases.nightlyCiReport.automationPrompt
