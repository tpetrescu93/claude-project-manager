# Project Manager Fork

Fork of [alefragnani/vscode-project-manager](https://github.com/alefragnani/vscode-project-manager) (v13.1.0). This document is a living record of what's been added on top of upstream and what remains as potential future work.

## Rendering approach

Two possible architectures for the sidebar view. The choice constrains which features are possible.

**TreeView API (current)**
- Uses VS Code's native tree rendering.
- Free: keyboard nav, context menus, selection state, accessibility, theme integration, drag/drop primitives.
- Limited: one line per item, one color per label, no custom layout, badges are text-only, inline buttons are hover-only.

**WebviewView (HTML/CSS/JS)**
- Full control over rendering: multi-line rows, arbitrary colors, custom layout.
- Lose: native keyboard nav, native context menus, native drag/drop, built-in accessibility. All must be rebuilt manually.
- Requires a separate JS/CSS bundle and a message-passing protocol between extension and webview.

We stuck with TreeView throughout. All shipped features below work within its constraints; the few features that genuinely need webview (rich two-line rows, icon overlays, custom right-aligned controls) are listed under "Potential future features".

---

## Visual customization

### Colored label text — ✅ DONE
Current project is highlighted via `FileDecorationProvider` using `projectManager.sideBar.currentProjectHighlightForeground`. One `ThemeColor` per row, applied to the whole label.

### Per-state icons — ✅ DONE
Each project shows an icon reflecting its dominant status (see Status tracking). Mix of `ThemeIcon` (codicons with `ThemeColor`) and custom SVGs in `images/`. Tabler icons are used for pin/unpin and Claude state markers; uxwing icon is used for merge-conflict warning.

### Animated indicators — ✅ DONE
Pending CI uses `ThemeIcon('sync~spin', charts.yellow)` — VS Code's native spinning animation. Claude thinking uses a custom SVG with SMIL opacity animation.

---

## Status tracking

### Claude session status — ✅ DONE
**Implementation:** tmux pane scraping every 2s, with diff-based thinking detection and a literal-string picker-footer match.

**States detected:**
- **Thinking** — capture the pane content above the live input prompt (`❯ `), compare to the previous capture for that project. If it changed → thinking. Why this works: when a spinner is active the leading glyph cycles every ~100ms, the elapsed-time counter ticks every second, content streams, and TODO checkboxes flip — the buffer is *always* changing during a turn. When idle, the spinner is gone and the content area is static.
  - Strips everything from the live `❯` down so typing in the prompt doesn't count, and the wall-clock line ticking each minute doesn't trigger a blip.
  - Catches multi-step TODO plans for free (the activeForm spinner cycles the same way; the TODO list updates as steps complete). The previous regex-based approach (`\b(Computing|Forging|Ionizing|Manifesting|Thinking)…`) missed multi-step plans entirely because the spinner verb in that mode is the task's `activeForm` text, not a built-in verb.
- **Needs input** — searches the last 15 lines of the raw pane capture for the literal `Enter to select · ↑/↓ to navigate · Esc to cancel`. The narrow scope avoids the false positive when that string appears in scrollback (e.g. source-code diffs displayed in the conversation buffer).

**Rendering:**
- Needs input: orange question-mark glyph (highest priority).
- Thinking: orange braille-dot swirl — a 2×3 dot grid animated through the 10-frame braille sequence ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ at 80ms/frame via SMIL `calcMode="discrete"` opacity. Pure SVG, self-animates, no JS tick. Mimics Superset's `AsciiSpinner` (`apps/desktop/src/renderer/screens/main/components/AsciiSpinner/AsciiSpinner.tsx`).
- Otherwise: falls through to PR/CI icon.

**Known gaps:**
- Background shells/monitors (`· 1 shell still running`) deliberately NOT counted as thinking — a dormant long-running process is registered work but isn't user-facing activity.
- Post-turn rest markers (`✻ Cooked for 3s`) are inherently static → correctly classified as idle.
- ~1 false-positive blip per minute if the visible content area happens to include any auto-ticking element. In practice none currently do (we strip the wall-clock line).

**Why tmux scraping (not hooks or jsonl).** Investigated all three; tmux won on coverage.

- **Claude Code hooks** (like Superset uses — `SessionStart` / `UserPromptSubmit` / `Stop` / `Notification` / `PostToolUseFailure` writing to state files via a generated `~/.claude/hooks/*.sh` script + patched `~/.claude/settings.json`). Cleaner semantically, push-based, and we have all the plumbing. The structural blocker: per the official docs, **the `Stop` hook does not fire on user interrupt (Ctrl+C / Esc)**. Superset's own listener admits this and falls back to terminal-exit detection (`Terminal.tsx` watching the embedded terminal's process). We don't own the terminal — Claude runs in tmux outside VS Code — so we can't replicate that fallback. A killed/interrupted session would leave the indicator stuck at `working` forever (or until the next `UserPromptSubmit` self-heals). `PostToolUseFailure` with `is_interrupt: true` catches *tool-phase* interrupts, but pure thinking-phase interrupts (rare in practice but present) are structurally undetectable from hooks alone. PID-of-claude check helps for "user killed the process" but not for "user Ctrl+C'd a turn".
- **JSONL transcript watching** at `~/.claude/projects/<encoded-cwd>/*.jsonl` via `fs.watch`. Rich data (per-turn entries with `stop_reason`, `tool_use`, etc.). Tried it; fundamental issues: distinguishing "Claude finished a turn" from "Claude is mid-turn" requires interpreting `stop_reason` values across many cases (`end_turn` / `tool_use` / `stop_sequence` / `max_tokens` / `pause_turn`); user prompts are encoded as a bare string in `message.content` (not a content-block array), forcing dual parse paths; the `[Request interrupted by user]` marker is written sometimes but not always; initial classification at startup keys off ancient stop_reasons, producing mass false-positive "needs input" for dormant sessions. Worked, but required a tmux-liveness gate to suppress the dormant-session false positives — which defeats the goal of being tmux-independent.
- **Tmux pane scraping** (what we ship). Reflects the actual rendered UI, so any state change — including Ctrl+C in any phase — implicitly clears the spinner from the visible pane. The trade-off is ~450 lightweight tmux forks per minute at N=15 projects. After trying several regex variants (hardcoded 5 verbs, generalised `…(\d+s` with optional footer/shell patterns) and hitting brittleness or scrollback false positives, we settled on a **content-diff** approach: capture the area above the live `❯` prompt, compare to previous tick, flag thinking when it changed. The diff is intrinsically TUI-agnostic (catches multi-step plans, new spinner glyphs, future Claude UI changes) and has none of the regex-tuning churn. Picker-footer detection is still a literal string match because a stuck picker is static (no diff) — but scoped to the last 15 lines so source-code-in-scrollback doesn't trigger it.

### Remote PR / CI / merge state — ✅ DONE
**Implementation:** in-process polling every 60s. One `gh pr list` per favorite, parallelised per-project with targeted tree refresh (or full re-sort when sort=Status).

**Data:** one bulk GraphQL query per cycle (replacing N parallel `gh` shell-outs).

The cycle resolves `(branch, owner, repo)` per project locally (`git rev-parse` + `git remote get-url`), groups projects by repo, and issues a single POST to `api.github.com/graphql` with aliased sub-queries:

```graphql
query {
  r0: repository(owner:"wagestream", name:"paydays-api") {
    p0: pullRequests(headRefName:"branch-a", states:[OPEN,MERGED], orderBy:{field:UPDATED_AT,direction:DESC}, first:3) {
      nodes { number url state mergeable reviewDecision mergedAt statusCheckRollup { state } }
    }
    p1: pullRequests(headRefName:"branch-b", ...) { ... }
  }
  r1: repository(owner:"wagestream", name:"admin-cubed") { ... }
}
```

Auth: shells out to `gh auth token` once, caches the bearer token in memory, drops the cache on a 401.

Response handling per PR: prefer an OPEN PR (then map to conflicting / changes_requested / pending / failing / approved / passing using the precomputed `statusCheckRollup.state`). Fall back to the most recent MERGED PR if no open one exists, marked `merged` if within `MERGED_WINDOW_DAYS`. Projects on `main`/`master`/`develop`/`HEAD` short-circuit to status `null` without an API call.

**Why bulk GraphQL** (replacing N REST shell-outs):
- 1 network request per cycle instead of N — eliminates the per-project request multiplier and the `gh` process spawn overhead (~100ms each × N).
- GitHub's REST limit is 5000 req/hr; at N=15 projects, REST polling capped at ~22s minimum to stay safe. GraphQL counts as 1 request per cycle, freeing the cadence.
- `statusCheckRollup.state` (PENDING/SUCCESS/FAILURE/ERROR/EXPECTED) is the pre-deduped overall state, so the historical-run dedup logic we needed against `gh pr list --json statusCheckRollup` is gone — GitHub does it for us.

**Polling cadence:** 6 seconds. Math: 600 queries/hr, each lean query ≈ 1 GraphQL point (we only ask for `statusCheckRollup.state`, not individual `contexts`), well under the 5000-point/hr GraphQL limit. If we asked for individual check runs we'd be at ~10 pts/query (over limit at this cadence) — that's why the query stays lean.

**Status enum** (`PrStatus`):
- `open_passing` — green check (CI green, no/awaiting review)
- `open_approved` — green double-check (`check-all`); CI green AND `reviewDecision === APPROVED`
- `changes_requested` — red `request-changes`; a human requested changes
- `open_failing` — red ✗
- `open_pending` — yellow spinner
- `open_conflicting` — yellow exclamation circle (conflicts beat CI; CI is moot until rebase)
- `merged` — purple merged glyph (within `MERGED_WINDOW_DAYS` of merge)
- `no_pr` — empty circle outline (also used as fallback when status hasn't been polled yet)
- `null` — same as no_pr semantically; transient

**Precedence** (first match wins): conflicting → changes_requested → CI failing → CI pending → approved → passing.

**Review detection:** `reviewDecision` is GitHub's computed decision and respects CODEOWNERS / branch-protection (not "one approval = approved"). It's `null` on repos with no required reviews, so `open_approved` only appears on protected repos.

**Important quirks handled:**
- `statusCheckRollup` returns every historical run of every check. Deduped by `name` keeping latest `completedAt` so re-runs supersede earlier failures (matches GitHub UI behaviour).
- `mergeable === "UNKNOWN"` (GitHub still computing) is ignored — doesn't override CI — to avoid flicker right after a push.
- `gh` transient failures (network, timeout) return `undefined` rather than `{status: null}` so the cached status doesn't get wiped to "no_pr" momentarily.

**Persistence:** status + URL cache stored in `globalState`, restored on activation so icons render immediately without waiting for the first poll.

**Archived optimization:** projects with `enabled: false` (archived) whose cached status is already `merged` are skipped in the polling loop — `merged` is terminal so the API call would be wasted. Unarchiving lifts the skip automatically on the next tick.

**Alternatives considered for fresher updates** (and why we landed on 6s bulk GraphQL):

- **Real subscriptions (webhooks)**: GitHub does support push delivery via webhooks (often paired with smee.io for local relay), but webhooks require repo-admin or org-admin permissions to configure. For wagestream repos that's not achievable for a personal extension, so polling is the only practical option.
- **REST polling with a shorter interval**: capped by the 5000 req/hr REST limit. At N=15 projects each cycle makes ~1 REST request, so the minimum safe interval is ~11s — and even at that rate the `gh` process-spawn cost (~100ms × N parallel) makes the loop heavy.
- **GraphQL with `statusCheckRollup.contexts(first:100)`**: returns ~50–100 nodes per PR, ~1000 nodes/query for 15 projects, ~10 points/query. At 6s that's 6000 pts/hr — over the GraphQL limit. So we deliberately fetch only `statusCheckRollup.state` and let GitHub's pre-computed rollup do the dedup.
- **Event triggers (filesystem watcher on `.git/refs/heads/<branch>`, `window.onDidChangeWindowState`)**: complementary to polling — they'd cut perceived latency on local pushes and tab re-focus to <1s. Not yet wired up; listed in Potential future features.
- **`gh pr checks --watch`**: gh has a "watch" mode but it's polling under the hood at a few-seconds cadence; running one per project means N persistent gh processes. Discarded.

### Sort by Status — ✅ DONE
Ranking (lowest = highest in list):
1. Claude needs input
2. Claude thinking
3. `open_conflicting`
4. `changes_requested`
5. `open_failing`
6. `open_pending`
7. `open_approved`
8. `open_passing`
9. `merged`
10. `no_pr`
11. unknown

Within a rank: alphabetical by label. When sort=Status is active, polling does a full tree re-sort instead of the usual per-node icon refresh.

### Local git status
Not implemented. Was scoped (branch name, dirty count, ahead/behind) but deferred — PR/CI status covers the higher-value signals.

---

## Project management actions

### Drag-and-reorder favorites — ✅ DONE
`TreeDragAndDropController` implementation. Within Favorites: persists the new order to `projects.json`. Within Git: persists a custom order to `gitItemOrder` in `globalState`.

### Clone-to-new-branch — ✅ DONE
Right-click a project → "Clone to New Project". Input box for branch name. Implementation in TypeScript (Option B from earlier spec):
1. `rsync -a --exclude='node_modules/' --exclude='.venv/'` to a sibling directory `<src>-<branch>`.
2. Clean git locks, fetch, checkout default branch (auto-detected from `origin/HEAD`), reset hard, then `git checkout -b <branch>`.
3. If `yarn.lock` or `package-lock.json` exists → `bun install && rm -f bun.lock bun.lockb`.
4. Register the new path in `projects.json` via `ProjectStorage.push()`.

Total runtime ~10–15s typical for a paydays-api clone.

### Archive / restore / delete workflow — ✅ DONE
Right-click → Archive moves an entry to a hidden "Archived" tree under Projects. Archive also kills the project's tmux session inline (`tmux kill-session -t "<name>" 2>/dev/null`, name = `basename(rootPath).replace(/\./g, "-")`). Archived rows have:
- Click-to-switch: opens the project, same as Favorites and Git.
- Inline buttons on hover: `$(discard)` Restore, `$(circle-slash)` Kill Tmux, `$(trash)` Delete (`inline@1` / `@2` / `@3`).
- Right-click menu mirrors the same three actions.

View-title buttons on the Archived view: `$(circle-slash)` "Kill All Archived Tmux Sessions" and `$(trash)` "Delete All Archived". Both iterate the disabled list and report a count.

The `killTmuxSession` helper is reused across archive/delete/kill paths; it returns whether a session actually existed so the kill-tmux commands can show "Killed N session(s)" vs "No tmux session was running" honestly.

Replaced an earlier cron-based cleanup approach which was clobbering archived entries on reboot.

### Pin / unpin Git auto-detected repos — ✅ DONE
Right-click any Git-detected project to pin it. Pinned state stored in `globalState` under `gitPinnedRepos`. Inline pin/unpin button on each row (`ico-pin-filled.svg` / `ico-pin-outline.svg`, hardcoded white).

Title-bar toggle "Show pinned only" filters the Git view to pinned repos only. The pinned set survives across reloads.

Pinned Git entries also appear in the drag-reorder flow and the Sort-by-Status ordering.

### Rename project — ✅ inherited from upstream
The existing rename command only changes the display name in `projects.json`; the rootPath is untouched. Extending rename to also `fs.rename` the underlying folder is potential future work (see below).

### Post PR to Slack + auto-react on merge — ✅ DONE
Inline Slack icon on each Favorites row. Click → confirmation modal with PR URL → spawns headless `claude -p --dangerously-skip-permissions` with the user's `pr-slack` skill. The skill posts a single-link Slack message (`<url|title>`, with `unfurl_links: false`) to a fixed channel, then prints `SLACK_POST: <permalink>` on its final line.

The extension parses that marker and stores `{rootPath → permalink}` in `globalState["slackPostsByRootPath"]`.

The 60s polling loop already detects `merged` transitions. When a project flips to `merged` AND has a stored permalink, the extension fires the `pr-slack-react` skill via another headless claude invocation, passing the permalink. The skill parses out `channel + ts`, calls `mcp__slack__add_reaction` with `name: merged_purple`, then the extension deletes the entry.

All claude invocations log full stdout/stderr to dedicated output channels (`Project Manager: Slack`, `Project Manager: Slack React`). Failure toasts have a "Show Logs" button.

**Why this shape:** the extension never handles Slack auth. Auth lives in Claude's MCP setup, which the user already has. Trade-off: each post/react is a 5–15s Claude round-trip vs an instant API call. Acceptable for a few-times-a-day workflow.

---

## Sidebar UI polish

- **Hidden tag UI** — `View as Tags`, `View as List`, `Filter by Tag`, `Edit Tags` are hidden across the view title, `…` submenu, right-click menu, and command palette via `when: false`. Underlying storage and providers untouched.
- **Git section starts collapsed by default** — `visibility: "collapsed"` on `projectsExplorerGit`. Originally dropped (so it expanded), but the resulting default panel height was awkward and there's no extension API for content-fit sizing, so collapsing is the lesser evil. The workbench remembers expand/collapse per workspace, so this only affects fresh layouts.
- **Click-to-switch on Git section** — dropped the `isGit ? undefined :` guard that previously made Git rows unclickable. Now click = switch workspace, same as Favorites.
- **Inline button order** — explicit `inline@1` / `inline@2` ordering on Favorites rows so Slack icon is first, Open PR icon is last.
- **Default icon = circle-outline** — projects without a polled PR status show the same "no PR" circle as projects that confirmed no PR, instead of the folder icon. Keeps the icon column visually consistent.
- **Cross-tree selection desync** — Favorites and Git rows use different `resourceUri` schemes (`projectManager-view` vs `projectManager-readonly-view`) so selecting a project in one tree doesn't highlight it in the other.
- **Replaced upstream icons** — name-prefix PR status (e.g. `[✅] foo`) and `✔` tick badges from upstream were removed in favour of dedicated icon slots. Inline "open PR in new window" button replaced by Open PR + Post to Slack buttons.

---

## Lifecycle hooks

### Tmux session lifecycle — ✅ DONE
The `_projectManager.openTmuxSession` command (right-click → "Open Tmux Session") creates a terminal that runs an inline shell command:

```
tmux attach -t "<session>" 2>/dev/null || tmux new -s "<session>"
```

Session name = `path.basename(rootPath)` with dots → dashes (same string the thinking-detection code uses for `capture-pane`, so the two stay in sync). No dependency on the user's `.bash_profile` — works on any system with bash + tmux.

After creation, the terminal is moved out of the bottom Terminal panel into the **editor area** via `workbench.action.terminal.moveToEditor`. The tab persists alongside code files, can be pinned, split, switched with `Cmd+1/Cmd+2`, and stays distinct from ad-hoc shells the user opens in the panel. If the user prefers a panel placement for one session, VS Code natively supports right-click → "Move Terminal into Panel" (and the reverse) on any terminal tab — no extension setting needed.

Subsequent invocations for a project whose `Tmux:` terminal already exists call `.show()` + `workbench.action.terminal.focus` to bring the existing tab back into view, instead of creating a duplicate.

The command does NOT auto-start `claude` (or anything else). On a *fresh* tmux session the user lands at a bash prompt and types whatever they want (`claude`, a REPL, etc.). On *subsequent* opens of the same project, attaches to the persistent tmux session that survives VS Code restarts, workspace switches, and even VS Code crashes (it's its own OS process).

**Persistence across workspace switches.** Requires `terminal.integrated.enablePersistentSessions = true` in user settings. VS Code then scopes terminals per-workspace and restores them on return. No explicit auto-launch on activation — the previously-saved editor tab simply reappears (or no tab appears on a fresh workspace).

Auto-launch on workspace activation was removed in favour of per-workspace restoration. Earlier iterations raced with VS Code's restoration logic and produced duplicate terminals or unwanted default-bash shells on fresh workspaces; persistent sessions + editor-tab placement sidesteps both.

**Why tmux remains load-bearing.** Tmux is the persistence layer that lets multiple Claude agents run independently in the background, one per project, surviving VS Code restarts and workspace switches. Replacing it with a chat webview (the conventional AI-extension pattern) would require building a separate daemon to hold Claude API sessions outside VS Code's lifecycle — duplicating what tmux provides for free. The extension is a viewer/attacher on top of tmux, not a session owner.

#### Research: can VS Code keep the shell process alive across a folder switch? (No.)

Investigated thoroughly because it determines whether tmux is essential or just nice-to-have. **Conclusion: tmux is essential — VS Code cannot natively keep a terminal's process running across a workspace folder switch.**

VS Code's terminal architecture: terminals are owned by a separate **pty host** process (not the renderer or extension host). Shells (bash/zsh and their children, e.g. `claude`) are children of the pty host. This is what enables persistence across UI churn — the renderer can restart while the pty host keeps shells alive.

VS Code has exactly **two** persistence triggers (per the [Terminal Advanced docs](https://code.visualstudio.com/docs/terminal/advanced)):
- **Reconnect** — on **window reload only** (e.g. installing an extension). The pty host still holds the live process; the renderer reattaches. Process keeps running.
- **Revive** — on **VS Code restart**, and empirically also on a **folder switch**. The process is torn down; scrollback is serialized to disk and a **fresh shell is relaunched** on return. The `* History restored` marker is the revive signature. The original process (and anything running in it, like `claude`) is dead — only replayed text remains.

A folder switch (`vscode.openFolder` to a different folder in the same window) **unloads the entire workspace** — file watchers, language servers, extension-host workspace state, AND terminal processes. The pty host process itself survives, but VS Code deliberately terminates the unloaded workspace's shells. This applies even to the round-trip A→B→A: returning to A does a *revive* (relaunch), not a *reconnect*, because A was unloaded when you left it.

No setting changes this. `terminal.integrated.persistentSessionReviveProcess` only controls *whether revive replays the buffer at all* — it does not upgrade a folder-switch into a reconnect. Reconnect is structurally reserved for in-place window reloads.

Ways to actually keep the process alive across a folder switch, in descending order of capability:
1. **tmux** (what we use) — the tmux *server* is its own OS process, not a child of the pty host. VS Code's bash shell just runs `tmux attach`; when VS Code kills that shell on unload, the tmux server (and `claude` inside it) keeps running, and the next `tmux attach` reconnects. Survives folder switches AND VS Code restarts/crashes.
2. **Separate window per project** (`forceNewWindow: true`) — window A never unloads A, so A's shells stay alive. Only solves folder switches, not VS Code restarts. UX cost: a window per project.
3. **Multi-root workspace** — all folders in one workspace, so navigating between them never unloads anything. Only solves folder switches; breaks the one-workspace-per-project model the whole sidebar is built around.

tmux is the only option that preserves the per-project-workspace UX *and* survives every teardown path.

Sources: [Terminal Advanced (VS Code docs)](https://code.visualstudio.com/docs/terminal/advanced), [Workspace-Specific Persistent/Saved Terminals #128001](https://github.com/microsoft/vscode/issues/128001), [Restore terminal sessions between restarts #44302](https://github.com/microsoft/vscode/issues/44302), [Persistent terminals in VS Code with tmux (George Honeywood)](https://george.honeywood.org.uk/blog/vs-code-and-tmux/).

---

## Potential future features

### Event-driven PR status triggers
Polling at 6s catches changes within ~3s on average, but two moments could feel sub-second with cheap event hooks:

- **Local push**: `FileSystemWatcher` on each project's `.git/refs/heads/<current-branch>`. When the file's mtime changes (you pushed or amended), fire an immediate re-poll for that project.
- **Window focus regained**: `window.onDidChangeWindowState` → trigger a full bulk poll. Coming back from Slack/browser shows fresh state immediately rather than after the next tick.

Both are ~60 lines combined, no rate-limit risk (they piggyback the existing bulk query), and would make "I just pushed and want to see CI start" feel instant.

### Soft workspace switch
Replace `vscode.openFolder(uri, …)` with `vscode.workspace.updateWorkspaceFolders(0, current.length, { uri: newUri })`. This mutates the workspace folder list in place — no window reload, no extension host restart.

**Win:**
- No 1–2s reload on every project switch.
- Extension host stays warm — biggest perceived speed-up.
- Editor layout, sidebar state, output panels persist.

**Cost:**
- Terminals don't auto-cwd. Options: `terminal.sendText("cd '<newPath>'")` per terminal, or dispose them, or hybrid (dispose Claude terminals, `cd` the rest).
- Open editors from the old folder remain visible (could be feature or nuisance).
- Workspace identity in VS Code is derived from the folder URI — per-workspace state *may* rebind to a different bucket on each swap. Worth testing.
- Extensions that only read `workspace.workspaceFolders` at activation (don't subscribe to `onDidChangeWorkspaceFolders`) will show stale state until manual reload. ~10–20% of extensions historically. Cmd+R is the escape hatch.

**Scope:** ~10–30 lines in `_projectManager.open`, plus terminal cleanup policy.

### Rename project + underlying folder
Today's rename only updates the display name in `projects.json`. Extending to also `fs.rename(oldPath, newPath)` is a small change, but the failure modes are real:
- Project currently open in any window → workspace path breaks mid-flight.
- External state doesn't follow: tmux session names, bash aliases, git worktrees, symlinks, IDE caches.
- Destination folder may already exist.
- Probably wants to be a separate command ("Rename Project & Folder") rather than overloading the existing one.

### Broader Claude state detection
Current regex catches `Computing|Forging|Ionizing|Manifesting|Thinking` spinner verbs. Doesn't catch:
- `Crunched for Ns` / `Cooked` — post-turn rest markers.
- `N monitor still running` / `N shells` — background tools alive.
- Queued user prompts pending submit.

A richer state machine could distinguish "Claude actively thinking" vs "Claude session alive but resting". Question is whether the user cares about the latter as a distinct visual state.

### Custom project description
`projects.json` has no user-facing description field. Adding one (with fallback to the auto-populated parent-dir path) is ~50 lines: schema field + tree item read + context-menu command + showInputBox. Deferred — `description` slot is already populated with the parent path, which is the most useful signal.

### Local git status
Branch name, dirty count, ahead/behind. Would use `git status --porcelain=v1 -b` per favorite, plus filesystem watchers on `.git/HEAD` and `.git/index` for cheap near-instant updates. Deferred — PR/CI status covers higher-value signals.

### Two-line rendering
Project name on line 1, status detail on line 2. Not possible in TreeView (fixed row height, single label/description slot). Workaround via nested children is ugly (disclosure triangles, broken keyboard nav). Would require switching to a WebviewView, which means rebuilding keyboard nav, context menus, drag/drop, and accessibility from scratch.

### Slack — multi-channel support
Today the `pr-slack` skill hardcodes a single channel ID. Could be extended to read channel from per-project config in `globalState` (or a JSON map in extension settings). Trade-off: extra UI to manage the mapping vs simplicity of one channel.

---

## Upstream viability

Based on the upstream repo's PR history (as of 2026-04-13):

- Actively maintained. Last push 2026-04-08, v13.1.0 released March 2026.
- Maintainer (alefragnani) does most feature work via GitHub Copilot's SWE agent.
- External contributor PRs for non-trivial features tend to sit open for months or get closed without merge.
- PR #884 ("Display Git branch in Side Bar") has been open since 2026-01-12. Overlapping with local-git-status if we ever build that.
- PR #922 ("Display Git Worktrees as Subdirectories") was closed within 5 hours — signals worktree/clone features may not be welcome.

Features most likely to be accepted upstream if proposed cleanly: drag-and-reorder.
Features unlikely: clone context menu, Claude status, PR/CI status, Slack integration (too personal/opinionated).

The fork stays a fork.

---

## Installation

VS Code can't install extensions from a git URL. Options:

1. **Build and install a .vsix** (current workflow):
   ```
   npm run webpack
   npx vsce package --out /tmp/project-manager-fork.vsix
   code --install-extension /tmp/project-manager-fork.vsix --force
   ```
   Reload the window for the new code to take effect — `--force` reinstall doesn't auto-reload running extensions.

2. **Symlink during development**: `ln -s <fork-dir> ~/.vscode/extensions/<publisher>.<name>-<version>`. Requires `npm run compile` after TypeScript changes + window reload.

3. **Extension Development Host (F5)**: launches a second VS Code window with the extension loaded from source. Standard dev loop.

### Skills (out-of-repo dependencies)

The Slack post + auto-react flow depends on two skills that live at `~/.claude/skills/` — outside this repo:

- `~/.claude/skills/pr-slack/SKILL.md` — posts the current branch's PR to a Slack channel, prints `SLACK_POST: <permalink>` marker for the extension to parse.
- `~/.claude/skills/pr-slack-react/SKILL.md` — given a Slack permalink, adds the `:merged_purple:` reaction.

These aren't versioned with the extension. Back them up separately.
