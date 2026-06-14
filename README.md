# Project Manager Fork — VS Code extension for Claude Code workflows

![Screenshot](images/screenshot.png)

This is a personal fork of the [VS Code Project Manager extension](https://github.com/alefragnani/vscode-project-manager) that integrates Claude Code, tmux, and GitHub status into the project switcher.

## Features

- **Per-project Claude in tmux** — each project gets a persistent `claude` CLI session in a tmux tab that survives window reloads, crashes, and project switches; quitting Claude drops to a login shell instead of killing the session
- **Project lifecycle** — clone-to-new-branch, fork (carrying the Claude session across), promote a scratch investigation to a real project, archive/restore, delete. Clone/fork/promote run in a detached worker, so they survive workspace switches
- **Fast clones** — local hardlink clone; the default branch is resolved and confirmed-fresh via one GraphQL call so the network fetch is skipped when the source is already up to date; the source's untracked symlinks (`.venv`, `CLAUDE.local.md`, …) are replicated; JS deps install on-demand
- **Curated Git view** — an explicit, extension-managed list of canonical repos (in `~/projects/.repos`) with Add/Remove, instead of scanning a folder. A background job keeps their default branches fast-forwarded to upstream (GraphQL-based detection, ~1 min cadence)
- **PR/CI status icons** that update every 6s (passing, failing, pending, conflicts, changes-requested, approved, merged), with sort-by-status
- **Claude live state** — thinking 🌀 / needs-input 🔔 indicators per project
- **Rich hover tooltip** — PR title, author, Jira link, Slack link, diff stats, tmux session uptime, Claude state
- **Ambient selection awareness** — your Claude session knows what you have selected in the editor (extension writes the selection, a `UserPromptSubmit` hook injects it), so "explain this" works with no paste
- **Post PR to Slack** with auto-react on merge
- **Investigations** — instant scratch sessions with auto-generated names, promotable to real git projects
- **Open tmux sessions as floating windows** for non-active projects

## Installation

1. Download [`claude-project-manager.vsix`](https://github.com/tpetrescu93/claude-project-manager/releases/latest/download/claude-project-manager.vsix) and install via Extensions panel → `···` → Install from VSIX
2. Required on PATH: `claude`, `tmux`, `gh`, `git`, `jq`, `bun`
3. Put canonical repos in `~/projects/.repos` (the Git view is a curated, extension-managed list seeded from there — use **Add Git Repo** to clone more); working copies from clone/fork land in `~/projects`.
4. Add to VS Code settings:
   - `"projectManager.slackChannelId": "<channel-id>"` (Slack channel to post PRs to — button hidden if unset)
   - `"terminal.integrated.enablePersistentSessions": true` (VS Code default — don't disable; required for tmux tabs to survive workspace switches)
5. **Slack posting** requires the Wagestream MCP gateway to be authenticated in Claude Code (`claude mcp` → slack). The extension calls `https://mcp.ai.corp.stream.co/slack/mcp` directly using the token Claude stores in the macOS Keychain — no skills or `claude -p` needed.
6. [.tmux.conf](https://gist.github.com/tpetrescu93/d8331e0e646de474824b232ca4ae52cf) (recommended tmux config)

## Credits

Built on top of [alefragnani/vscode-project-manager](https://github.com/alefragnani/vscode-project-manager). Licensed under GPLv3.
