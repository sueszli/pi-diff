# pi-diff

A [pi](https://pi.dev) extension that adds a `/diff` command: it opens the current git repository in VS Code and opens a side‑by‑side diff tab for every changed file, so you can review what the agent (or you) changed.

## Install

```bash
pi install git:github.com/sueszli/pi-diff
```

Or try it once without installing:

```bash
pi -e git:github.com/sueszli/pi-diff
```

Requires `git` and the VS Code `code` CLI on your `PATH` (VS Code → Command Palette → *Shell Command: Install 'code' command in PATH*).

## Usage

| Command | What it shows |
|---|---|
| `/diff` | working tree vs `HEAD` (staged, unstaged, untracked) |
| `/diff main` | working tree vs `main` |
| `/diff HEAD~3` | working tree vs three commits ago |
| `/diff --max 50` | raise the tab cap (default 20) |

For each changed file the extension:

- **modified / renamed** → `code --diff <base version> <working file>`
- **added / untracked** → opens the file
- **deleted** → opens the base version

The base versions are written to `$TMPDIR/pi-vscode-diff/…` with their original extension so VS Code picks the right syntax highlighting. A summary (status + path per file) is also rendered in the pi transcript.

## License

MIT
