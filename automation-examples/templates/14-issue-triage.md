# Triage new issues and suggest owners and priority.

ID: `issue-triage`
Mode: `worktree`
Icon: `exclamationmark-bubble`

Card preview:

Triage new issues; suggest owner, priority, and labels.

Full automation prompt:

```
Triage new issues; suggest owner, priority, and labels.

Grounding rules:
- Base recommendations on issue content + repo context (CODEOWNERS, touched areas, prior similar issues).
- Do not guess owners without signals; if unclear, say “Owner: Unknown” and suggest a team instead.
```

Source message ids:

- home.useCases.issueTriage.prompt
- home.useCases.issueTriage.automationPrompt
