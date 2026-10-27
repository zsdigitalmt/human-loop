# human-loop

A Claude Code mod that gives the agent one way to ask you something: a **Needs Human** pane. The agent calls a tool, the question shows up as a row with one button per option, and a single click sends your answer back and clears the row. Work carries on while the question waits.

## What you get

- **`ask_human` tool.** The agent asks a one-line question with 2 to 4 options, can mark one as recommended, and can add a cost and a line of context to each. It gets an id back (`NH-<n>`) and keeps working.
- **Needs Human pane.** Each open question is a row. The recommended option is starred and listed first. **Other…** lets you type an answer instead. A question left open for more than 24 hours is tagged `STALE`.
- **One click, one answer.** Your pick arrives as your next message, `NH-<n> answer: <option>`, with the question attached so it still makes sense after a compaction. Pressing twice sends nothing more.
- **Other sessions, read-only.** Open questions from your other Claude Code sessions on the same machine are listed under their session name, so you can see what is waiting elsewhere.
- **Housekeeping tools.** `resolve_need` closes a question you answered in chat, `withdraw_need` drops one that no longer matters, and `list_needs` lists what is open. None of these sends a prompt.
- **Status line.** Shows `NH <open> (+<n> other)`.
- **Navigation extras.** Message timestamps, plus `/bm [label]` to bookmark a message and `/last`, `/prev`, `/next` to jump between prompts.

Commands: `/needs` opens the pane. If another skill or mod already uses a command name, that one command is skipped and the rest still load.

## Install

```
/plugin install human-loop --marketplace zsdigitalmt/human-loop
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install human-loop --marketplace zsdigitalmt/human-loop
```

In the desktop app, click + next to the prompt box, then Plugins. Choose Add marketplace and enter `zsdigitalmt/human-loop`, then choose Add plugin.

To update an installed copy to the latest version, run `/plugin marketplace update human-loop`.

To tell the agent to use it, add a line like this to your `CLAUDE.md`:

> Ask me for any decision, approval or missing input with `mcp__human-loop__ask_human`, not in prose.

## Where it keeps state

- Open and closed questions live in Claude Code's per-mod store. Closed ones are kept for 7 days, then dropped.
- So other sessions can see them, each session also writes its open questions to `~/.claude/needs-human/<session-id>.json`. Nothing leaves your machine.

## Develop

```
claude plugin validate .
claude plugin test .
```

`GOALS.md` lists the behaviours (G1 to G10) and the test for each one.

## Licence

MIT, see [LICENSE](LICENSE).
