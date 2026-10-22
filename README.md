# human-loop

A Claude Code mod for running several sessions at once without losing track of what is waiting on you.

- **Needs pane.** Any line in a reply that starts with `[NEEDS-KEITH]` or `[NEEDS-HUMAN]` becomes a flag in the pane. A flag stays until you tick it or a later reply carries `[NEEDS-DONE] <start of the flag text>`. When a reply has no flags, a closing question is picked up instead.
- **Cross-session.** Every session writes its needs to `~/.claude/needs-human/<sessionId>.json`, so each pane also counts what other sessions on the same machine are waiting for.
- **Status line.** Shows `⚑ N need you (M other) · /needs`.
- **Timestamps and navigation.** Each message gets a timestamp. Jump between prompts and bookmark messages.

## Install

At the prompt of a terminal session:

```
/plugin install human-loop --marketplace zsdigitalmt/human-loop
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install human-loop --marketplace zsdigitalmt/human-loop
```

In the desktop app, click + next to the prompt box, then Plugins. Choose Add marketplace and enter `zsdigitalmt/human-loop`, then choose Add plugin.

## Commands

| Command | What it does |
|---|---|
| `/needs` | Open the Needs pane |
| `/need <text>` | Flag something by hand |
| `/needs-clear` | Clear this session's needs |
| `/prev`, `/next`, `/last` | Jump between your prompts |
| `/bm [label]` | Bookmark the latest message |

To use the band hotkeys, focus the band with ctrl+x tab or a click. Then `n` opens the pane, `p`/`j` go to the previous/next prompt, `l` goes to the latest, and `m` bookmarks.
