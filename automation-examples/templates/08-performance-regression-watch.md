# Watch for performance regressions in recent changes.

ID: `performance-regression-watch`
Mode: `worktree`
Icon: `bar-chart`

Card preview:

Compare recent changes to benchmarks or traces and flag regressions early.

Full automation prompt:

```
Compare recent changes to benchmarks or traces and flag regressions early.

Grounding rules:
- Ground claims in measurable signals (benchmarks, traces, timings, flamegraphs).
- If measurements are unavailable, state “No measurements found” rather than guessing.
```

Source message ids:

- home.useCases.performanceRegressionWatch.prompt
- home.useCases.performanceRegressionWatch.automationPrompt
