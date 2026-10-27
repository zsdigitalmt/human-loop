# Needs Human (NH): goals

A pane of open questions from the agent to its human. One click answers a question and removes it.

Each goal has a test that must fail when its feature is removed (mutation proof), then pass.

| # | Goal | Test |
|---|---|---|
| G1 | `ask_human` adds an `NH-<n>` row with the question and one button per option | render |
| G2 | One click on an option submits exactly one prompt naming the id, the question and the option, and removes the row | submit stubbed |
| G3 | "Other…" opens a field; Enter submits the typed answer the same way | input |
| G4 | An answered or withdrawn question never draws again, including after a reload | reload |
| G5 | `[NEEDS-…]` marker lines in replies add no rows | structural: the mod has no `turn.complete` hook and no marker parser (the kit cannot raise `turn.complete`, so no render test) |
| G6 | The recommended option is marked ★ and drawn first | render |
| G7 | A second press on an already-sent question submits nothing | double press |
| G8 | A question open longer than 24h is tagged STALE | mocked clock |
| G9 | Other sessions' open questions are listed read-only, under their session name | render |
| G10 | `withdraw_need` and `resolve_need` remove a row without a prompt | tool call |

Done: `claude plugin validate` clean, `tsc` clean, `claude plugin test` green, each goal's test shown red with its feature removed.
