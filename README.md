# pi-auto-collapse

An Antigravity-style tool transcript for [pi](https://pi.dev): consecutive
tool calls collapse into verb lines, long sequences run in a bounded live
activity window, and thinking blocks show a sliding 3-line preview.

Tool execution, results, and model context are untouched — only the display
changes. Expansion always falls back to pi's built-in rendering (syntax
highlighting, diffs, full output).

## What it looks like

One call renders as a single verb line. The live output streams while the
command runs, folds away when it finishes, and comes back on click:

```text
● Ran 1 command (go test ./...) · 2.4s
```

Two consecutive calls fold to verb lines when the sequence completes. From
the third call on, a bounded activity window slides over the live output,
holds for at least two seconds after completion, then folds:

```text
┌─ ● 2 done, 1 running… ────────────────────────────┐
│ ● Bash(npm test)
│   ⎿ … +12 lines above
│   ⎿ ✓ All tests passed
└───────────────────────────────────────────────────┘

… 4 more actions (2 reads, 1 search, 1 command) …
● Ran 2 commands (npm test · pnpm build)
● Read 1 file (output.txt) · 4.2s (ctrl+o to expand)
```

Consecutive same-tool calls merge into one verb line (`Ran N commands`,
`Read N files`, `Searched N patterns`, `Updated N files`, ...). The status
dot is a traffic light: green done, amber running, grey pending, red failed.
Failed calls always stay visible, folded or not.

Thinking blocks keep only their last lines by default (a sliding preview
while streaming); `/think-full` toggles the full text, `Ctrl+T` hides
thinking behind an `○ Thinking…` label.

## Install

```bash
pi install github:austiecodes/pi-auto-collapse
```

Or copy `extensions/compact-tools.ts` into `~/.pi/agent/extensions/` and
run `/reload`.

## Interaction

| Action | Effect |
|---|---|
| Click a group line / window | Expand the group |
| `Ctrl+O` | Expand or collapse all tool output |
| `/think-full` | Toggle full thinking vs the 3-line preview |

## Tunables

All in `extensions/compact-tools.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `KEPT_CLUSTERS` | `3` | Verb lines kept before older ones compress |
| `INLINE_ARGS` | `3` | Arguments shown inside a verb line |
| `BODY_LINES` | `10` | Live tail height per running tool |
| `MIN_WINDOW_MS` | `2000` | Minimum window display after completion |
| `THINKING_TAIL_LINES` | `3` | Thinking preview height |

## Notes and limits

- Groups split on messages without tool calls (a thinking-only or text-only
  assistant message ends the consecutive sequence).
- Resumed sessions have no live group state; their rows fall back to the
  built-in call line plus a one-line result summary.
- MCP and other extension tools are transparent to grouping: they render with
  default handling.
- Other extensions that re-register the same built-in tools will conflict
  with this one; load only one tool-rendering extension at a time.
