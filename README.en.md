# dsh-import-workbuddy

English | [中文](README.md)

~~Because WorkBuddy's free DeepSeek ride is ending soon~~

Moves WorkBuddy conversations into DSH. The imported sessions keep their full history, and you can pick the conversation up from there.

The other import plugins (`dsh-import-agents` and friends) cover pi / opencode / codex / claude-code. None of them know WorkBuddy. They also can't recover tool results, since those formats only record the call, so they write placeholders. WorkBuddy keeps the actual output in its jsonl, and this plugin copies it over untouched.

## Install

From npm (once published):

```sh
dsh plugin --profile web add dsh-import-workbuddy
```

From source:

```sh
cd dsh-import-workbuddy
dsh plugin --profile web add .
```

From git:

```sh
dsh plugin --profile web add github:musewizard/dsh-import-workbuddy
```

Restart `dsh web` and reload the page afterwards. The old page's connection is already gone.

## Usage

Type these in the chat box:

```sh
/workbuddy-list                  # see what's available
/import-workbuddy                # import everything
/import-workbuddy --dry-run      # preview, write nothing
```

Useful flags:

- `--limit 5` only the 5 most recent
- `--project dfyqq` filter by directory name
- `--since 2026-10-20` only sessions touched after this date
- `--tool-truncate 4000` cut tool output longer than 4000 characters
- `--no-tools` drop tool calls, keep just the conversation

Running it twice won't duplicate anything. Session ids are fixed as `wb-<original id>`, and ones already imported get skipped.

Sessions land in a workspace matching their original directory, created if needed. If that directory no longer exists, they stay ungrouped.

## Configuration

Set it on the plugin entry in your profile:

```yaml
- id: import-workbuddy
  name: dsh-import-workbuddy
  config:
    toolTruncate: 4000
    attachWorkspaces: false
    root: "E:/portable/workbuddy/projects"
```

`toolTruncate` defaults to `0`, meaning no truncation.

`root` usually doesn't need setting. The plugin looks in these places:

```
$WORKBUDDY_HOME/projects
~/.workbuddy-ai/projects
~/.workbuddy/projects
~/Library/Application Support/WorkBuddy/projects   (macOS)
~/.config/workbuddy/projects                       (Linux)
%APPDATA%/WorkBuddy/projects                       (Windows)
```

Where WorkBuddy itself is installed doesn't matter. The data lives in your home directory.

## What doesn't make it

- **Images.** WorkBuddy stores them as blob references, and DSH's content blocks have no image type. You get a text placeholder (`[图片: filename]`) with the original blob path, but the image bytes don't transfer.
- **Token usage.** WorkBuddy doesn't record it, so the DSH side stays empty.
- **`job/approval/retry/stream` runtime events.** They don't exist in the source files, so nothing is generated. Reading history is unaffected.

Command output is currently in Chinese. The plugin works the same either way; only the status lines differ.

## Tests

```sh
npm test
```

22 cases, all synthetic fixtures — your own sessions are never touched. `tests/validate.mjs` is an event-sequence validator that checks the layout rules DSH enforces.

## Uninstall

```sh
dsh plugin --profile web remove dsh-import-workbuddy
```

Sessions you've already imported stay put. To clean them up, delete the `wb-*` directories under `~/.dsh/sessions`.

## License

MIT
