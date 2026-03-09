# Synthesize this week’s PRs, rollouts, incidents, and reviews.

ID: `weekly-engineering-summary`
Mode: `worktree`
Icon: `figure-text-document`

Card preview:

Synthesize this week’s PRs, rollouts, incidents, and reviews into a weekly update.

Full automation prompt:

```
Synthesize this week’s PRs, rollouts, incidents, and reviews into a weekly update.

Grounding rules:
- Do not invent events; if data is missing, say that briefly.
- Prefer concrete references (PR #, incident ID, rollout note, file path) where available.
```

Source message ids:

- home.useCases.weeklyEngineeringSummary.prompt
- home.useCases.weeklyEngineeringSummary.automationPrompt
