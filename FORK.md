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
- **Needs input** — matches `/Enter to select.*Esc to cancel/` in the last 15 lines of the raw pane capture. Matching the stable ends of the picker footer catches every variant: single-select (`↑/↓ to navigate`), the AskUserQuestion multi-picker (`Tab/Arrow keys to navigate`), etc. Single-line match (`.` excludes newline) keeps it anchored to the one footer line; the 15-line scope avoids false positives when the string appears in scrollback (e.g. source-code diffs in the conversation buffer).

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
**Implementation:** in-process polling every 6s via a single bulk GraphQL query (see cadence note below). Targeted per-project tree refresh on change, or full re-sort when sort=Status.

**Data:** one bulk GraphQL query per cycle (replacing the original N parallel `gh pr list` shell-outs).

The cycle resolves `(branch, owner, repo)` per project locally (`git rev-parse` + `git remote get-url`), groups projects by repo, and issues a single POST to `api.github.com/graphql` with aliased sub-queries:

```graphql
query {
  r0: repository(owner:"wagestream", name:"paydays-api") {
    p0: pullRequests(headRefName:"branch-a", states:[OPEN,MERGED], orderBy:{field:UPDATED_AT,direction:DESC}, first:3) {
      nodes { number url state mergeable reviewDecision mergedAt statusCheckRollup { state } reviewThreads(first:100) { nodes { isResolved } } }
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

**Polling cadence:** 6 seconds. Math: 600 queries/hr, each query ≈ 1–2 GraphQL points (1 for status alone; 2 once `reviewThreads` is included at ~47-PR scale) — ~1,200 pts/hr, well under the 5000-point/hr GraphQL limit. We still avoid individual `contexts` (asking for check runs would be ~10 pts/query, over limit at this cadence) — that's why the query stays lean apart from the cheap thread scan.

**Status enum** (`PrStatus`):
- `open_passing` — green check (CI green, no/awaiting review)
- `open_approved` — green double-check (`check-all`); CI green AND `reviewDecision === APPROVED`
- `changes_requested` — red `request-changes`; a formal CHANGES_REQUESTED review **or** ≥1 unresolved review thread (an inline comment awaiting your reply/resolve)
- `open_failing` — red ✗
- `open_pending` — yellow spinner
- `open_conflicting` — yellow exclamation circle (conflicts beat CI; CI is moot until rebase)
- `merged` — purple merged glyph (within `MERGED_WINDOW_DAYS` of merge)
- `no_pr` — empty circle outline (also used as fallback when status hasn't been polled yet)
- `null` — same as no_pr semantically; transient

**Precedence** (first match wins): conflicting → changes_requested → CI failing → CI pending → approved → passing.

**Review detection:** `reviewDecision` is GitHub's computed decision and respects CODEOWNERS / branch-protection (not "one approval = approved"). It's `null` on repos with no required reviews, so `open_approved` only appears on protected repos.

**Unresolved-comment detection:** `changes_requested` also fires on any open review thread (`reviewThreads.nodes[].isResolved === false`), independent of `reviewDecision` — so an inline comment you haven't replied to/resolved surfaces the red state even without a formal "request changes" review. Capped at "any unresolved" (we don't count them — one is enough). `first:100` caps the thread scan; a PR with >100 threads where every unresolved one sits past the first 100 would be missed, which is implausible in practice. **Cost/latency:** fetching `reviewThreads` is server-side work GitHub does per PR — at ~47 PRs it nudges the bulk query from 1 → 2 GraphQL points and adds ~1s wall-clock (≈3.2s → ≈4.2s median, measured 2026-06-02). Harmless: the fetch is a 6s background poll that updates icons asynchronously and never blocks the UI, with ample headroom under the 6s interval. The watched-node incremental scheme (poll one cached unresolved thread by ID, re-scan on resolve) was designed to avoid this +1s but rejected — it trades one background query for a per-cycle state machine plus its own round-trips, to shave latency off something that doesn't block anything.

**Important quirks handled:**
- We query `statusCheckRollup.state` (GitHub's precomputed overall rollup), so the historical-run dedup we needed against the old REST `gh pr list --json statusCheckRollup` is no longer necessary — GitHub returns the deduped state directly.
- Only `mergeable === "CONFLICTING"` short-circuits to the conflict state; any other value (`MERGEABLE`, or `UNKNOWN` while GitHub is still computing) falls through to the CI checks, so a freshly-pushed PR doesn't flicker.
- Network / auth failures return `undefined` rather than `{status: null}` so the cached status isn't wiped to "no_pr" momentarily; a 401 also drops the cached `gh auth token` so it's re-fetched next cycle.

**Persistence:** status + URL cache stored in `globalState`, restored on activation so icons render immediately without waiting for the first poll.

**Archived optimization:** projects with `enabled: false` (archived) whose cached status is already `merged` are skipped in the polling loop — `merged` is terminal so the API call would be wasted. Unarchiving lifts the skip automatically on the next tick.

**Alternatives considered for fresher updates** (and why we landed on 6s bulk GraphQL):

- **Real subscriptions (webhooks)**: GitHub does support push delivery via webhooks (often paired with smee.io for local relay), but webhooks require repo-admin or org-admin permissions to configure. For wagestream repos that's not achievable for a personal extension, so polling is the only practical option.
- **REST polling with a shorter interval**: capped by the 5000 req/hr REST limit. At N=15 projects each cycle makes ~1 REST request, so the minimum safe interval is ~11s — and even at that rate the `gh` process-spawn cost (~100ms × N parallel) makes the loop heavy.
- **GraphQL with `statusCheckRollup.contexts(first:100)`**: returns ~50–100 nodes per PR, ~1000 nodes/query for 15 projects, ~10 points/query. At 6s that's 6000 pts/hr — over the GraphQL limit. So we deliberately fetch only `statusCheckRollup.state` and let GitHub's pre-computed rollup do the dedup.
- **Event triggers (filesystem watcher on `.git/refs/heads/<branch>`, `window.onDidChangeWindowState`)**: would cut perceived latency on local pushes and tab re-focus to <1s. Considered and dropped — once polling dropped to 6s the marginal benefit didn't justify the extra moving parts.
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
Right-click a project → "Clone to New Project". Input box for branch name (stores just the branch — the folder is `<repo>-<branch>` by convention, but `name` in `projects.json` is just the branch). Steps:
1. `git clone <sourcePath> <targetDir>` — local hardlink clone (~2.4s for paydays-api vs ~11.5s for rsync).
2. `git fetch origin` + detect canonical default branch (`origin/HEAD` → fallback to `main`/`master`/`develop`) → `git reset --hard origin/<default>` so the new branch always starts up-to-date regardless of what the source had checked out.
3. `git checkout -b <branch>`.
4. Symlink `.venv`: if source has a symlink `.venv` → `cp -P` (copy the symlink itself); if source has a real `.venv` dir → `ln -s`. Either way instant — no `uv sync` needed for same-deps branches.
5. If `yarn.lock` or `package-lock.json` exists → `bun install && rm -f bun.lock bun.lockb`.

**Benchmark (paydays-api):** local clone 2.4s, fetch+reset 5.9s → ~8s total vs ~17.5s with the old rsync approach.

**Runs in the background — survives workspace switches.** All three heavy operations (clone, fork, promote) previously ran in-process via `await` chains that died when a workspace switch reloaded the extension host, silently abandoning the operation mid-rsync/git/bun. Now each operation:
1. Gathers inputs in-process (input boxes, session ID snapshot).
2. Spawns a **detached bash script** (built inline as a string in TypeScript, no file to distribute) with `{ detached: true }` + `child.unref()` — outlives the ext host.
3. Returns immediately with a "Running in background" toast.
4. On success the script writes `~/.project-manager/pending-projects/<id>.json` with `{name, rootPath}`. On failure it writes `~/.project-manager/pending-projects/<id>.error` with the error message + log path (`~/.project-manager/clone-logs/<id>.log`).
5. The extension **reconciles** on activation (covers the workspace-switch case) and via `fs.watch` on the pending dir (instant on macOS/FSEvents) + a 5s interval fallback (Linux/Windows where `fs.watch` is unreliable). Success files add the project to `projects.json`; error files surface a toast with a "Show Log" button.

The pending file approach (rather than writing directly to `projects.json`) is deliberate: the extension rewrites `projects.json` wholesale on every save and only reads it at load — an external writer would race it and the result wouldn't be seen live.

### Fork Project + Claude Session — ✅ DONE
Right-click a project that has a Claude session → "Fork Project + Claude Session...". Clones it to a new folder/branch (reusing the clone flow) AND carries the Claude conversation across so a new agent resumes where the old one left off, then diverges.

- **Name prompt** is prefilled with the source project's name, pre-selected for editing; the edited value becomes both the new folder name and the git branch (matches the folder≈branch convention). Blocks if left identical to the source.
- **Session copy**: finds the source's newest transcript in `~/.claude/projects/<encoded-source-cwd>/`, copies it (and the subagent dir, recursively, best-effort, skipping non-regular files like IPC sockets) into `~/.claude/projects/<encoded-new-cwd>/`, **rewriting every entry's `cwd`** to the new path via `jq` — same mechanism as the `move` skill. Without the rewrite, `--resume` stays pinned to the source folder.
- **Resume**: the detached bash script starts `claude --resume <session-id>` in a detached tmux session after the clone completes. Switching to the fork and "Open Tmux Session" attaches to the already-running resumed session.
- Toast offers an "Open Project" button to switch immediately, or you ignore it and keep working where you are.
- The operation runs in the background (see Clone section) — safe to switch workspaces while it runs.

Resolved the spec's open questions: `--resume` keys by session ID (`-r, --resume [value]` = "Resume a conversation by session ID"); the encoded dir is `rootPath.replace(/\//g, "-")` (leading dash kept); the fork *copies* (independent divergence, not shared); only `cwd` is rewritten (embedded paths in message history are left as historical record). `performClone` was factored out of `cloneProject.ts` for reuse.

### Investigations — ✅ DONE
Lightweight scratch sessions for agent work that doesn't (yet) need a git checkout — "why is this failing in prod?", "explain this subsystem", "draft a query". A `$(add)` "New Investigation" button on the Projects view title prompts for a name and creates one near-instantly.

Design decisions that landed (some reversing the original sketch below):
- **Storage**: investigations are **normal `projects.json` entries**, flagged `kind: "investigation"` (optional field on the `Project` model). No separate store. The flag rides through `storage.ts` load/`map`/`getProjectsByTag(s)`, and `StorageProvider.buildNode()` branches on it to emit an `InvestigationNode` (magnifying-glass `$(search)` icon) instead of a `ProjectNode`. Earlier this used a dedicated `globalState` store (`investigationStore.ts`) and a separate sidebar section — both removed. Investigations now live **in the same Projects list**, not a section of their own.
- **Folder**: an **empty scratch dir** created in `~/projects/<slug>` (slugified name, `Date.now()`-suffixed on collision). No git, no rsync, no install — just `mkdir`. Created empty on purpose; not a pointer at an existing repo.
- **No auto-start**: creation only registers the investigation. tmux/Claude is started on demand via "Open Tmux Session" (the same `_projectManager.openTmuxSession` flow as a normal project).
- **Opens like any project**: clicking does the same hard workspace switch (`_projectManager.open`); the row highlights as the current project (via `resourceUri` + the `projectManager-view` decoration) and gets the same Claude thinking/needs-input status icons (the status poll picks investigations up automatically now that they're in `projects.json`; they're skipped only in the git/PR status fetch, having no branch).
- **Promote** (`$(rocket)`): turns a scratch investigation into real work. Picks a **pinned Git repo** (the filtered Git section), runs the **clone flow** (same detached bash script as Clone/Fork) into a fresh `~/projects/<name>` folder, **carries the Claude session across** (transcript copied + `cwd`-rewritten), resumes it in a tmux session, then tears down the scratch investigation (kill tmux, `rm -rf` folder, pop the entry). Runs in the background — safe to switch workspaces while it runs.
- **Fork** (`$(git-branch)`, right-click only): split an investigation into two parallel lines. Creates a *new* scratch investigation in `~/projects`, carries the source's latest Claude session across (`copySessionWithCwdRewrite` + `latestSessionId`, same as the project Fork), resumes it in a detached tmux session, and leaves the source intact — so both share history up to the split point.
- **Delete** (`$(trash)`): kills the tmux session (exact `=name` match) and removes both the folder and the `projects.json` entry, with a modal confirm.

Inline buttons on an investigation row: `$(terminal)` Open Tmux, `$(rocket)` Promote, `$(trash)` Delete. Fork is right-click only. Context menu mirrors all of them.

### Archive / restore / delete workflow — ✅ DONE
Right-click → Archive moves an entry to a hidden "Archived" tree under Projects. Archive also kills the project's tmux session inline (`tmux kill-session -t "<name>" 2>/dev/null`, name = `basename(rootPath).replace(/\./g, "-")`). Archived rows have:
- Click-to-switch: opens the project, same as Favorites and Git.
- Inline buttons on hover: `$(discard)` Restore, `$(circle-slash)` Kill Tmux, `$(trash)` Delete (`inline@1` / `@2` / `@3`).
- Right-click menu mirrors the same three actions.

View-title buttons on the Archived view: `$(search)` Search (filters the list by typing — query matched against the `repo · branch` display label; a `$(search-stop)` clear button appears when active), `$(circle-slash)` "Kill All Archived Tmux Sessions", and `$(trash)` "Delete All Archived". Both iterate/kill/delete the full disabled list and report a count.

The `killTmuxSession` helper is reused across archive/delete/kill paths; it returns whether a session actually existed so the kill-tmux commands can show "Killed N session(s)" vs "No tmux session was running" honestly.

Replaced an earlier cron-based cleanup approach which was clobbering archived entries on reboot.

### Pin / unpin Git auto-detected repos — ✅ DONE
Right-click any Git-detected project to pin it. Pinned state stored in `globalState` under `gitPinnedRepos`. Inline pin/unpin button on each row (`ico-pin-filled.svg` / `ico-pin-outline.svg`, hardcoded white).

Title-bar toggle "Show pinned only" filters the Git view to pinned repos only. The pinned set survives across reloads.

Pinned Git entries also appear in the drag-reorder flow and the Sort-by-Status ordering.

### Rename project — ✅ inherited from upstream
The existing rename command only changes the display name in `projects.json`; the rootPath is untouched. Extending it to also `fs.rename` the underlying folder was considered and rejected: renaming a folder out from under a live tmux+Claude session orphans the tmux session (name is frozen at creation), breaks thinking detection, degrades the running process's cwd (`$PWD` goes stale, `getcwd` can fail on macOS), and desyncs Claude's transcript dir (`~/.claude/projects/<encoded-cwd>/`). Not worth the failure modes.

### Post PR to Slack + auto-react on merge — ✅ DONE
Inline Slack icon on each Favorites row. Click → confirmation modal with PR URL → runs the user's `pr-slack` skill via headless `claude -p --dangerously-skip-permissions`. The skill posts a single-link Slack message (`<url|title>`, with `unfurl_links: false`) to a fixed channel, then prints `SLACK_POST: <permalink>` on its final line.

**Durable across workspace switches.** The post is **detached and self-recording**: clicking spawns a `bash -lc` script with `{ detached: true }` + `child.unref()` that runs claude, greps the `SLACK_POST:` permalink, writes it to the store *itself*, logs output, and deletes the throwaway session transcript (snapshot/diff in-shell). This survives a hard workspace switch tearing down the extension host mid-run — the old in-process `on("close")` handler died with the host, so the message posted but the permalink was lost. The command returns immediately; the row flips to the "posted" icon on the next poll.

The permalink store is **file-backed**, not `globalState`: one file per project at `~/.project-manager/slack-posts/<encoded-rootPath>.url` (with lazy migration of legacy `globalState["slackPostsByRootPath"]` entries on first read). File-backed precisely *because* the detached process must record its own result, and an external process can't write the extension's `globalState`. `getSlackPost` reads the file fresh, so the detached write surfaces with no reload. (`projects.json` is the wrong target for an externally-written value: the extension rewrites it wholesale on every reorder/archive and only reads it at load, so an external writer would race it and wouldn't be seen live.)

The 6s polling loop already detects `merged` transitions. When a project flips to `merged` AND has a stored permalink, the extension fires the `pr-slack-react` skill via another headless claude invocation, passing the permalink. The skill parses out `channel + ts`, calls `mcp__slack__add_reaction` with `name: merged_purple`, then deletes the entry on success.

A **Remove Slack Link** right-click command (`deleteSlackPost`) clears a stored permalink manually — reverting the "posted" overlay and stopping the merge reaction for that PR. An **Attach Slack Link** right-click command (`attachSlackPost`) does the reverse — prompts for a permalink URL and stores it, activating the "posted" overlay and the merge auto-react — for PRs posted to Slack manually outside the extension.

The detached post writes full output to a per-project log under `~/.project-manager/slack-logs/`. If the script exits without producing a `SLACK_POST:` permalink (failed claude run, skill not found, auth issue), it writes an error file to `~/.project-manager/pending-projects/slack-<id>.error` — the same reconciler that handles clone/fork/promote errors picks it up and shows a "Show Log" toast. The merge-react invocation logs to the `Project Manager: Slack React` output channel.

**Why this shape:** the extension never handles Slack auth. Auth lives in Claude's MCP setup, which the user already has. Trade-off: each post/react is a 5–15s Claude round-trip vs an instant API call. Acceptable for a few-times-a-day workflow.

**Known limitation — the merge-react is not interrupt-safe.** `reactToMergedPr` spawns `claude -p` as a child of the extension host. Switching workspaces reloads the window, which restarts the extension host and kills/orphans that child mid-run — and since the react is a slow 5–15s round-trip that fires right when a PR merges (exactly when you tend to move to the next project), the interrupt window is wide. Worse, the react only fires on the `oldStatus !== "merged" → "merged"` *transition*; once interrupted the status is already cached `merged`, so the edge never recurs and the reaction is permanently missed (the stored permalink is left dangling because `deleteSlackPost` only runs on success). **Fix (not yet implemented):** make it self-healing — on activation / each poll, for any rootPath that still has a stored permalink AND is cached `merged`, re-fire the react. `reactions.add` is idempotent (`already_reacted` = success), so re-firing is safe even if an orphaned process already completed it. This turns "fire once, lose on interrupt" into eventually-consistent.

---

## Sidebar UI polish

- **Hidden tag UI** — `View as Tags`, `View as List`, `Filter by Tag`, `Edit Tags` are hidden across the view title, `…` submenu, right-click menu, and command palette via `when: false`. Underlying storage and providers untouched.
- **Git section starts collapsed by default** — `visibility: "collapsed"` on `projectsExplorerGit`. Originally dropped (so it expanded), but the resulting default panel height was awkward and there's no extension API for content-fit sizing, so collapsing is the lesser evil. The workbench remembers expand/collapse per workspace, so this only affects fresh layouts.
- **Click-to-switch on Git section** — dropped the `isGit ? undefined :` guard that previously made Git rows unclickable. Now click = switch workspace, same as Favorites.
- **Inline button order** — explicit `inline@1` / `inline@2` ordering on Favorites rows so Slack icon is first, Open PR icon is last.
- **Default icon = circle-outline** — projects without a polled PR status show the same "no PR" circle as projects that confirmed no PR, instead of the folder icon. Keeps the icon column visually consistent.
- **Cross-tree selection desync** — Favorites and Git rows use different `resourceUri` schemes (`projectManager-view` vs `projectManager-readonly-view`) so selecting a project in one tree doesn't highlight it in the other.
- **Replaced upstream icons** — name-prefix PR status (e.g. `[✅] foo`) and `✔` tick badges from upstream were removed in favour of dedicated icon slots. Inline "open PR in new window" button replaced by Open PR + Post to Slack buttons.
- **`repo · branch` display labels** — projects store a `repoName` field (e.g. `"paydays-api"`) alongside the branch-only `name` (e.g. `"my-feature"`). The display label is rendered as `paydays-api · my-feature` in both the Projects and Archived views. Set from `git remote get-url origin` at clone/fork/promote time. A one-shot migration on activation backfills `repoName` and strips the repo prefix from any legacy full-name entries; guarded so it becomes a no-op once all projects are migrated. Investigations are unaffected.
- **Defocus sidebar + focus terminal on project switch** — VS Code restores sidebar focus on workspace reload, leaving the cursor in the project list. On activation, the extension waits for `window.onDidChangeWindowState` (window focused = workbench fully rendered), then: if a `Tmux:` terminal exists → focus it; if `autoStartTmux` is set → create the session; otherwise → `focusActiveEditorGroup` to defocus the sidebar.

### Rich project tooltip — ✅ DONE
Hovering a project/investigation row shows an at-a-glance card (`buildProjectTooltip` in `commands/projectTooltip.ts`), built **lazily via `StorageProvider.resolveTreeItem`** — `getTreeItem` clears the eager tooltip so VS Code invokes resolve only for the hovered node, and an 8s TTL cache absorbs hover jitter. The card is a `MarkdownString` with `supportThemeIcons` + `supportHtml` + `isTrusted` (HTML enables the colored spans).

Layout (open PR):
- **PR title + number** as a link, with **`· @author`** alongside it.
- **`jira: <KEY>`** link on its own line — key extracted from the PR title's bracketed prefix, falling back to the branch's leading `key-number` convention; links to `wagestream.atlassian.net/browse/<KEY>`.
- **Slack** link directly below Jira (from the Slack post store).
- **`updated <age> ago`** from the PR's `updatedAt`.
- **PR/CI status** — the `PrStatus` in words with a **colored icon** (green pass/approved, red failing/changes, amber pending/conflict, blue posted, purple merged) and neutral text.
- **Diff stats** — `+additions` (green) `−deletions` (red) `· N files`, from the PR's computed merge diff; falls back to a local `git diff --shortstat <base>...HEAD` only when there's no PR (resolving the redundant-both decision in favour of PR-level-when-present).
- **Unresolved vs total review threads** (red if any unresolved, green if all resolved) and a **conflicts-with-base** flag.
- **git block** (lazy): branch + dirty/unpushed flags, all from a single `git status --porcelain=v2 --branch`.
- **session block**: tmux uptime + Claude state (working / waiting for input / idle).

Investigations skip the git block (no repo) and lead with a `$(search)` marker + path. Merged / no-PR rows drop the PR block and carry Jira / Slack / Open PR in a footer instead.

**Data:** the 6s bulk GraphQL query was extended to also cache `title`, `author`, `updatedAt`, `additions`/`deletions`/`changedFiles`, and review-thread counts into a `PrMeta` map (`getPrMetaForPath`) — measured cost stays ~2 points (see Remote PR section). **Perf:** the common case (project has a PR) resolves with **3 fully-parallel shell-outs** (status, tmux, and nothing else — the local diff/base resolution runs only when there's no PR). The VS Code hover *delay* itself is the user setting `workbench.hover.delay` (default 500ms), out of the extension's control.

---

## Lifecycle hooks

### Tmux session lifecycle — ✅ DONE
The `_projectManager.openTmuxSession` command (right-click → "Open Tmux Session") creates a terminal that runs an inline shell command:

```
tmux attach -t "<session>" 2>/dev/null || tmux new -s "<session>"
```

Session name = `path.basename(rootPath)` with dots → dashes (same string the thinking-detection code uses for `capture-pane`, so the two stay in sync). No dependency on the user's `.bash_profile` — works on any system with bash + tmux.

For the **current project's** session the terminal is created **directly in the editor area** (`location: TerminalLocation.Editor`) rather than in the bottom Terminal panel, so there's no panel→editor flash. The tab persists alongside code files, can be pinned, split, switched with `Cmd+1/Cmd+2`, and stays distinct from ad-hoc shells the user opens in the panel. If the user prefers a panel placement for one session, VS Code natively supports right-click → "Move Terminal into Panel" (and the reverse) on any terminal tab — no extension setting needed.

**Floating window when the project isn't open.** If the session's `rootPath` matches an open `workspace.workspaceFolders` entry, the tab stays docked here (the editor terminal above). If it belongs to a *different* project, the terminal is popped into a floating (auxiliary) window via `workbench.action.terminal.moveIntoNewWindow` — so you get the session without switching your current workspace. The API can't place a terminal directly in an auxiliary window, so it's created here and then moved out (the one remaining bit of motion). This path deliberately uses the **default** terminal location, not an editor terminal: `moveIntoNewWindow` needs the terminal focused via `workbench.action.terminal.focus`, which targets the panel group — focusing it that way on an editor terminal steals focus to the panel and the move then acts on the wrong target (an editor-location float silently failed to open the new window).

Subsequent invocations for a project whose `Tmux:` terminal already exists call `.show()` + `workbench.action.terminal.focus` to bring the existing tab back into view, instead of creating a duplicate.

The command does NOT auto-start `claude` (or anything else). On a *fresh* tmux session the user lands at a bash prompt and types whatever they want (`claude`, a REPL, etc.). On *subsequent* opens of the same project, attaches to the persistent tmux session that survives VS Code restarts, workspace switches, and even VS Code crashes (it's its own OS process).

**Auto-start on first open.** When `_projectManager.open` is called, the extension runs `tmux has-session -t "=<name>"` before the workspace switch. If no session exists, it writes a one-shot `{ rootPath, name }` flag to `globalState["autoStartTmux"]`. On activation in the new workspace, if that flag is set, it is immediately cleared and `openTmuxSession` is fired — either immediately if `window.state.focused` is already true, or deferred via `window.onDidChangeWindowState` until the window becomes focused (ensures the workbench is fully rendered before `createTerminal` + `moveToEditor` run). If a session already exists, no flag is set and the existing session is left alone.

**Persistence across workspace switches.** Requires `terminal.integrated.enablePersistentSessions = true` in user settings. VS Code then scopes terminals per-workspace and restores them on return.

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

### Gate thinking detection on Claude being the foreground process
The diff-based thinking detection (see Claude session status) only knows "this tmux pane's content changed" — it has no concept of whether Claude is actually running. So a long-running *non-Claude* command in that session (`npm test`, `tail -f`, etc.), or typing at a bash prompt that doesn't use the `❯` character, can falsely light up the thinking swirl. Could gate on the foreground process via `tmux display-message -p '#{pane_current_command}'` (check for `claude`/`node`) before treating a diff as "Claude thinking". Deferred — in practice each tmux session here is dedicated to Claude, so false positives are rare.

### Persist Claude thinking/needs-input across workspace switches
The thinking/needs-input caches are in-memory only (unlike PR status, which persists to globalState). On a workspace switch the icons blank until the next 2s tmux poll repopulates them — a visible flicker. Tried persisting the caches to globalState and restoring on activation (like PR status); it did **not** eliminate the flicker (the tree renders before/around the restore, and the 2s poll re-fires regardless), so it was reverted. A real fix likely needs the restore to happen synchronously before the first tree render, or to suppress the first post-switch poll-driven refresh when the cached value is unchanged. Deferred — needs more investigation into the activation/render ordering.

### Custom project description
`projects.json` has no user-facing description field. Adding one (with fallback to the auto-populated parent-dir path) is ~50 lines: schema field + tree item read + context-menu command + showInputBox. Deferred — `description` slot is already populated with the parent path, which is the most useful signal.

### Local git status
Branch name, dirty count, ahead/behind. Would use `git status --porcelain=v1 -b` per favorite, plus filesystem watchers on `.git/HEAD` and `.git/index` for cheap near-instant updates. Deferred — PR/CI status covers higher-value signals.

### Two-line rendering
Project name on line 1, status detail on line 2. Not possible in TreeView (fixed row height, single label/description slot). Workaround via nested children is ugly (disclosure triangles, broken keyboard nav). Would require switching to a WebviewView, which means rebuilding keyboard nav, context menus, drag/drop, and accessibility from scratch.

### Slack — remove the skill dependency, post natively
Today posting to Slack and reacting on merge both shell out to `claude -p` to invoke the `pr-slack` / `pr-slack-react` skills, which use Claude's MCP Slack auth. This means the extension depends on (a) `claude` being on PATH, (b) the user having those two skills installed at `~/.claude/skills/`, and (c) Claude's MCP Slack integration being authenticated — none of which are reasonable to assume for anyone but the author. Each post is also a 5–15s LLM round-trip.

Replace with a native Slack integration in the extension:
- **Auth**: OAuth flow (or a bot/user token entered once into `SecretStorage`) — the extension owns the credential, no MCP dependency. A VS Code `UriHandler` catches the OAuth redirect. (Note the current MCP auth is *not* reusable: it's an OAuth session against a Wagestream corp gateway `mcp.ai.corp.stream.co`, with the token in the macOS Keychain under `Claude Code-credentials` — there's no Slack token to lift. Going native means either re-OAuthing against that gateway or standing up a separate Slack app/token, the latter possibly subject to Slack-admin policy.)
- **Post / react**: call Slack's Web API (`chat.postMessage`, `reactions.add`, `chat.getPermalink`) directly over HTTPS from an embedded script. Sub-second, no `claude` process, no skill files.
- Removes the cross-machine fragility (skills live outside the repo and aren't versioned with it) and makes the feature shippable to other users.

**Benchmark justification (measured 2026-06-01).** Posting a Slack message by shelling out to `claude` is ~8–11s and there's no way to speed it up while keeping `claude` in the loop:

| Path | Time | Notes |
|------|------|-------|
| Cold `claude -p`, Opus 4.8 | ~11.3s | avg of 2 |
| Cold `claude -p`, Haiku | ~11.3s | avg of 2 — identical to Opus |
| Hot (send-keys into a live, warm session) | ~7.7s | corroborated by claude's own "Sautéed for 7s" |

Findings: (1) **model choice is irrelevant** — Opus and Haiku are identical, so the inference is a small slice and "use a faster model" buys nothing; (2) **a warm session saves only ~3.5s** (the CLI cold-start + MCP-connect cost), still leaving ~8s; (3) the **dominant, irreducible cost in both paths is the MCP tool round-trip to the remote corp gateway + inference** — present whether cold or hot. Only a native HTTPS call (no `claude`, no MCP protocol, no remote gateway hop unless we deliberately keep it) gets to sub-second. Also noted during benchmarking: `tmux send-keys "text" Enter` does **not** reliably submit to Claude's TUI (the text lands as multiline input and Enter inserts a newline) — you must send the text, pause, then send `Enter` as a separate keystroke, and even then it's flaky. A relevant wrinkle for the "session actions via send-keys" idea below.

### Session actions — one-click commands injected into the live session
A generic version of the Slack button: register a list of `{icon, label, keystrokes}` actions (in settings) that render as inline buttons on project rows and, on click, inject the keystrokes into that project's live tmux+Claude session (`tmux send-keys`). Turns any slash command or prompt (`/pr-slack`, `/rebase-and-monitor`, "commit and push") into a one-click row button, reusing the already-authenticated warm session — which sidesteps the whole Slack-auth problem for one-way "go do this" actions.

Caveats (from the benchmark above and the detection work): submission via send-keys is flaky (text + *separate, delayed* Enter, and still occasionally sticks); it must be gated on Claude being the foreground process AND idle (else keystrokes land in bash or interleave with a running turn); and it's fire-and-forget — no result captured. So it fits one-way actions but NOT the merge-react (which needs the message `ts` back) — that stays on a mechanism that can capture output.

### Slack — multi-channel support
Today the channel ID is hardcoded. Could be extended to read channel from per-project config in `globalState` (or a JSON map in extension settings). Trade-off: extra UI to manage the mapping vs simplicity of one channel. (Pairs naturally with the native-Slack work above.)

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

## Editing capability vs Conductor / Superset

Neither Conductor nor Superset is a full editor — both expect you to open your real IDE for serious hand-editing (researched 2026-06-01):

- **Conductor** has a light built-in file editor (syntax highlighting + ⌘F) and a diff/review viewer, but explicitly tells you to "open the workspace in your favorite IDE to make edits" and ships a VS Code extension for exactly that bounce-out.
- **Superset** has its own chat / diff / file editor / in-app browser, but explicitly "integrates with VS Code, Cursor, Xcode, JetBrains… rather than being based on them" — i.e. it is **not** a Code-OSS fork; its editing surface is a lighter custom implementation.
- Neither has VS Code's depth: no extension ecosystem, no full LSP/IntelliSense, no debugger, no refactoring tools, none of your accumulated config/keybindings.

Because this fork lives *inside* VS Code, it gets 100% of VS Code's editing for free while adding the orchestration on top. Conductor/Superset force a context-switch (orchestrate in their app, edit in VS Code); this collapses it into one surface.

Sources: [Conductor](https://www.conductor.build/), [Conductor diff/edit blog](https://www.conductor.build/blog/diff-tools), [Superset](https://superset.sh/), [superset-sh/superset](https://github.com/superset-sh/superset).

---

## VS Code native agents vs this extension

VS Code shipped a native **Agents window / Agent Sessions** (in Stable as of 1.120, May 2026, still labelled **Preview**) that runs Claude (via Anthropic's official Agent harness), Codex, and Copilot as local / background / **cloud** agents, with a unified sidebar to delegate and compare outputs. It overlaps heavily with this extension and is the biggest "why does this exist" pressure. Researched 2026-06-01.

| Dimension | VS Code native agents | This extension |
|-----------|----------------------|----------------|
| What runs | Claude via Anthropic's "Agent harness" integration (+ Codex, Copilot) | The real Claude Code **CLI** with your full setup — skills, MCP, `CLAUDE.md`, permission wrappers |
| Execution | Local, background, **cloud** (remote infra) | Local tmux only |
| Persistence | Local agents tied to VS Code lifecycle (docs don't claim restart-survival); cloud persists server-side | tmux survives VS Code restart / crash / folder-switch |
| Parallelism | Subagents in parallel; background agents in isolated worktrees | One persistent session per project; switch between projects |
| **Auth / cost** | **Requires a paid GitHub Copilot seat** (Claude needs Pro/Business, Codex needs Pro+). Free tier excludes third-party agents. **Cannot** BYO Anthropic account / Claude Code CLI auth — billing is exclusively through Copilot | Your existing Claude (Max/Team) subscription via the CLI; **zero Copilot dependency** |
| Workflow extras | None PR/Slack-specific | PR/CI/review status column, post-to-Slack, react-on-merge |
| Editing | Full VS Code (in-editor) | Full VS Code (in-editor) — tie |

**Where VS Code native is genuinely better:** cloud/background delegation (fire a long task at remote infra, close the laptop); multiple agent *types* side by side (Claude + Codex + Copilot); official, cross-platform, no tmux/shell-scraping fragility.

**Where this extension is genuinely better:** runs your *actual configured* Claude Code CLI (skills/MCP/CLAUDE.md/permissions), not a harness integration; sessions survive anything via tmux; uses your existing Claude subscription with **no Copilot seat required**; project-switcher model + PR/Slack lifecycle.

**The decisive point for this setup:** VS Code's native agents are inaccessible without a paid Copilot subscription, and you can't route your own Claude plan through them — even the "Claude" agent bills through GitHub. So for someone who already pays for Claude, doesn't want a Copilot seat, and runs a heavily-customized Claude Code CLI, the native path isn't just different — it's unavailable. The tmux+CLI approach is the only way to get *your* Claude, in VS Code, on *your* subscription.

Unverified caveat: whether VS Code's *local* agents survive a window reload/restart — docs are silent (usually means "no"). If they ever add tmux-grade local persistence, this extension's biggest differentiator shrinks (though the Copilot-dependency and own-CLI points stand regardless).

Sources: [Use the Agents window (Preview)](https://code.visualstudio.com/docs/copilot/agents/agents-window), [Third-party agents in VS Code](https://code.visualstudio.com/docs/copilot/agents/third-party-agents), [VS Code 1.120 release notes](https://code.visualstudio.com/updates/v1_120), [Claude/Codex for Copilot Business & Pro (GitHub Changelog)](https://github.blog/changelog/2026-02-26-claude-and-codex-now-available-for-copilot-business-pro-users/), [VS Code multi-agent blog](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development).

---

## Installation

VS Code can't install extensions from a git URL. Options:

1. **Download the latest release** (easiest): grab `claude-project-manager.vsix` from the [latest release](https://github.com/tpetrescu93/claude-project-manager/releases/latest/download/claude-project-manager.vsix) and install via Extensions panel → `···` → Install from VSIX. A **GitHub Action** rebuilds and republishes the `.vsix` on every push to `master` — the download URL is stable (`releases/latest/download/claude-project-manager.vsix`), always points to the newest build. The release title shows the short SHA + CI run number; the body links to the exact commit and CI run for traceability.

2. **Build and install locally**:
   ```
   npm run webpack
   npx vsce package --out /tmp/claude-project-manager.vsix
   code --install-extension /tmp/claude-project-manager.vsix --force
   ```
   Reload the window for the new code to take effect — `--force` reinstall doesn't auto-reload running extensions.

3. **Symlink during development**: `ln -s <fork-dir> ~/.vscode/extensions/<publisher>.<name>-<version>`. Requires `npm run compile` after TypeScript changes + window reload.

4. **Extension Development Host (F5)**: launches a second VS Code window with the extension loaded from source. Standard dev loop.

### Skills (out-of-repo dependencies)

The Slack post + auto-react flow depends on two skills that live at `~/.claude/skills/` — outside this repo:

- `~/.claude/skills/pr-slack/SKILL.md` — posts the current branch's PR to a Slack channel, prints `SLACK_POST: <permalink>` marker for the extension to parse.
- `~/.claude/skills/pr-slack-react/SKILL.md` — given a Slack permalink, adds the `:merged_purple:` reaction.

These aren't versioned with the extension. Back them up separately.
