# VS Code Workspace Switching — Investigation Notes

What happens when a VS Code window switches from one folder to another, why parts of it are slow, and every option found for making it faster. General VS Code findings, not specific to any extension.

## The VS Code process model

A VS Code window is several OS processes:

| Process | Owns |
|---|---|
| Renderer | the window UI: editor tabs, layout, sidebar, terminal *tabs* |
| Pty host | terminal shell processes (survives even renderer reloads) |
| Extension host | a Node process running **all** extensions |
| Main process | app lifecycle, window management |

What "switching workspaces" costs depends entirely on which of these get torn down.

## Hard switch vs soft switch

**Hard switch — `vscode.openFolder`** (what VS Code does by default):
- Full window reload: renderer tears down and rebuilds
- Extension host restarts
- All editors close (VS Code restores them per-workspace afterward)
- All terminal processes are killed and *revived* (scrollback replayed as text; the processes themselves are dead)
- Workspace identity cleanly becomes the new folder

**Soft switch — `vscode.workspace.updateWorkspaceFolders(0, n, { uri })`**:
- Renderer survives: no white flash, layout/panels/terminal processes intact
- Extension host **still restarts** (see below — this is the catch)
- Nothing resets itself: open tabs and terminals linger and must be managed manually
- Workspace identity mutates (see untitled workspace note below)

The soft switch is perceptibly faster because the renderer reload is the visually dominant cost. But anything an extension renders (tree views, status bars) still rebuilds, because extensions live in the extension host.

## Why the extension host always restarts

Verified in the VS Code source. The restart due to a **folder change** and the restart due to a **workspace (identity) change** are two separate code paths in different files, with very different weights:

1. **Workspace change (identity transition) — heavy.** `workspaceEditingService.enterWorkspace` (`src/vs/workbench/services/workspaces/electron-browser/workspaceEditingService.ts`) fires whenever the window moves to a *different workspace identity* — opening a `.code-workspace`, or a single-folder window being converted to a multi-root workspace. It stops all extension hosts ("Opening a multi-root workspace"), **migrates per-workspace storage**, rebinds workspace identity, then restarts. Replacing the folder of a single-folder window lands here: `abstractWorkspaceEditingService.updateFolders` special-cases it (`includesSingleFolderWorkspace` → `createAndEnterWorkspace`), converting the window into an **untitled multi-root workspace**. So a "folder swap" on a single-folder window is really a workspace-mode transition — the unlucky, heavy case.

2. **Folder change (within a workspace) — pure bounce.** The `WorkspaceChangeExtHostRelauncher` contribution (`src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`) watches `onDidChangeWorkspaceFolders`; if folder 0's URI changed, it calls `stopExtensionHosts()` + `startExtensionHosts()` in place — same workspace identity, no storage migration, nothing else. It exists solely to keep the deprecated `workspace.rootPath` API pointing at folder 0. The listener is only installed in multi-root (`WORKSPACE`) state — single-folder windows are ignored (path 1 covers those).

(A third tier sits above both: `vscode.openFolder` to a different folder/workspace = full window reload, where the ext-host restart is incidental to the renderer teardown.)

The separation matters for patching: path 2 is a self-contained few-line class that could be neutered trivially; path 1 is entangled with workspace identity and storage migration.

The official `updateWorkspaceFolders` JSDoc documents this: changing the first workspace folder "causes the currently executing extensions (including the one that called this method) to be terminated and restarted".

**There is no config, flag, or API to suppress it.** VS Code's own investigation into removing the restart — [#69335](https://github.com/microsoft/vscode/issues/69335), prompted by [#66936](https://github.com/Microsoft/vscode/issues/66936) — has been open since 2019. The stop is also atomic: `stopExtensionHosts` → `_doStopExtensionHosts` → `_extensionHostManagers.stopAllInReverse()`. No per-host filtering exists at any layer of the public API, even though per-host structure exists internally (affinity-based host managers).

Side effects of the restart that masquerade as other bugs:
- Module-level state in extensions is wiped — suppression flags can't survive the switch
- After the restart, `onDidChangeConfiguration` events report `affectsConfiguration() === true` for essentially **every** section (the workspace config scope was replaced), so config-change handlers fire spuriously
- `FileDecorationProvider`s get re-queried for all visible items

## The untitled workspace side effect

After path 1 fires once, the window is an "Untitled (Workspace)". By default VS Code shows a save/discard dialog when that workspace is abandoned (switching away or closing the window). Kill the prompt with:

```json
"window.confirmSaveUntitledWorkspace": false
```

(verified in `workspaceEditingService.ts` — when `false`, the untitled workspace is always discarded silently).

## Options for a faster switch

### 1. Soft switch + manual UI reset (works, partial win)

Use `updateWorkspaceFolders`, accept the ext-host restart, and replicate the reset a reload would have done: close editors (`workbench.action.closeAllEditors`), dispose unwanted terminals, reopen what the new context needs.

Things learned doing this:
- **Race window after the swap**: the ext-host restart is scheduled, not instant — code right after `updateWorkspaceFolders` runs on borrowed time. Single one-way operations (e.g. `createTerminal`, which is a fire-and-forget message to the renderer) reliably win the race and survive the host's death. Multi-step RPC loops (e.g. opening N documents) can be cut off halfway.
- **State handoff**: anything the post-restart host needs must go through `globalState`/disk before the swap — never module variables.
- **Two-pass restore pattern**: fire-and-forget the restore optimistically from the dying host (instant when it wins), and have the new host's activation do a sequential completeness pass (idempotent — re-opening an open file is a no-op).
- **Editor-area terminals** are editors: `closeAllEditors` closes them. For tmux-backed terminals that's just a detach.

### 2. Anchor folder at index 0 (the only true fix for the restart)

Keep a permanent dummy folder at index 0 and swap the *real* project at index 1. The relauncher only fires on folder-0 changes, so index-1 swaps restart nothing — extensions stay warm, their UI never rebuilds.

Costs:
- Entering/leaving the multi-root arrangement still restarts at the boundaries (single↔multi transitions)
- The anchor folder appears in Explorer, search scope, and Quick Open; a large anchor (e.g. a parent dir of all repos) means heavy recursive file watchers — use a tiny empty dir
- Everything that assumes `workspaceFolders[0]` is "the project" breaks: many extensions (and much first-party tooling) anchor to folder 0 for linting, git, language servers
- Workspace identity becomes the multi-root workspace, not the folder — per-workspace state (terminals, layout, settings) rebinds accordingly

### 3. Patching VS Code core

VS Code is open source; the restart triggers are small and findable:
- Path 2 (`WorkspaceChangeExtHostRelauncher`) is a tiny self-contained class — a global "don't restart" patch is a few lines
- A *per-extension* exemption is structurally harder: all extensions share one ext-host process by default, so exempting one extension requires process isolation first (`extensions.experimental.affinity` can isolate an extension into its own host) plus threading a filter through `stopExtensionHosts` → `stopAllInReverse` (small refactor; the per-host managers already exist internally)
- Path 1 (`createAndEnterWorkspace`) is a heavier workspace transition with storage migration — a host filter doesn't help there

Delivery options, both with real maintenance costs:
- **Patch the installed app**: the workbench is minified JS (`Code.app/Contents/Resources/app/out/...`). Doable; triggers the "installation appears corrupt" warning (checksum tools exist); wiped by every monthly VS Code update
- **Build Code-OSS from source**: clean TypeScript patch, but the official marketplace is licensed to Microsoft builds only, and you own the build/update treadmill

Risk either way: skipping the restart globally leaves any extension that caches folder 0 at activation (git tooling, language servers) operating against a stale root until manual reload — the exact edge-case swamp that stalled VS Code's own attempt (#69335).

### 4. Things that don't work

- Any in-extension suppression of the rebuild (flags, event-handler guards, disabling decorations) — the rebuild *is* the ext-host restart; the extension's own state dies with the host
- Settings: nothing in `terminal.integrated.persistentSessions*`, `window.*`, or anywhere else changes the restart behavior
- `gh`/docs spelunking confirmed: reconnect-without-restart is structurally reserved for in-place window reloads, not folder switches

## Related: terminal persistence across switches

VS Code has exactly two terminal persistence modes (Terminal Advanced docs):
- **Reconnect** — window reload only: the pty host still holds the live process; the renderer reattaches
- **Revive** — VS Code restart *and* folder switches: process is dead, scrollback replayed as text

A folder switch always revives, never reconnects — even A→B→A. The only way to keep real processes alive across switches is to host them outside VS Code's lifecycle (tmux: the VS Code shell just runs `tmux attach`; killing it detaches, the tmux server and everything in it keeps running).

---

## Implementation as built (the `soft-switch` branch, commit `bed5956`)

This section records the working implementation that lived on the `soft-switch` branch before it
was abandoned (master's `_projectManager.open` / activation code diverged too far to rebase). It is
captured here so the feature can be re-implemented on current master if desired. The approach
chosen was **Option 2 (anchor folder at index 0)** — and it *worked*: investigation→investigation
switches had no window reload **and** no extension-host restart (the sidebar did not rebuild).

### Anchored workspace model (`src/utils/anchorWorkspace.ts`)

- A permanent empty anchor dir `~/.project-manager/anchor` and a saved workspace file
  `~/.project-manager/investigations.code-workspace` with `folders: [ {path: anchor}, {path: investigation} ]`.
- The anchor sits at **index 0** and never changes; the investigation lives at **index 1** and is
  swapped via `updateWorkspaceFolders(1, n-1, {uri})`. Because folder 0 is untouched, VS Code does
  **not** restart the extension host (the whole point — see "Why the extension host always restarts").
- Helpers: `isAnchoredWorkspace()` (current window is the investigations workspace, by
  `workspace.workspaceFile`); `activeProjectPath()` (the project the window is "on" — folder 1 when
  folder 0 is the anchor, else folder 0). The latter replaced raw `workspaceFolders[0]` reads in
  `decoration.ts` and `askClaude.ts` so current-project highlight / session lookup stay correct.

### Transition matrix

- **investigation → investigation, already in the anchored workspace** → true soft switch (swap
  index 1 in-process; no reload, no restart).
- **anything → investigation, not yet anchored** → hard boundary: write the workspace file and
  `vscode.openFolder` it (window reload); the new host's activation finishes the restore.
- **investigation → project, project → anything** → normal hard `vscode.openFolder`.

### Soft-switch path (in-process, `_projectManager.open`)

1. `suppressConfigEventsUntil = Date.now() + 2000` — the folder swap fires `onDidChangeConfiguration`
   with `affectsConfiguration()` true for everything (workspace config scope changed); a time-boxed
   module flag makes the config handler no-op so it doesn't trigger a spurious project rescan. (Works
   here *only because* the host survives the swap — module state persists.)
2. `closeAllEditors`, then dispose every terminal except the target's `Tmux: <name>` (a panel-located
   tmux isn't an editor tab, so `closeAllEditors` misses it and it would otherwise carry the old
   session into the new investigation).
3. Swap folder 1: `updateWorkspaceFolders(1, len-1, {uri})`. It applies **asynchronously**, so await
   `onDidChangeWorkspaceFolders` (1s fallback timeout) before restoring, or the restore reads the old
   folder list.
4. `openRecordedTabs(projectPath)`; if no tmux terminal exists afterward, open it.

### Entry path (hard, into the anchored workspace)

Write the `.code-workspace`, set one-shot globalState flags `restoreTabsFor` and `autoStartTmux`,
then `vscode.openFolder` the workspace file. On the new host's activation, `restoreInvestigationTabs`
(gated on `restoreTabsFor` matching a current folder) replays the tabs and `autoStartTmux` opens the
session — the shared workspace identity means VS Code won't restore per-investigation terminals on
its own.

### Per-investigation UI state (`globalState["investigationOpenTabs"]`)

VS Code keys its own editor-state persistence to the workspace identity, which is *shared* across all
investigations in the anchored workspace — so it can't distinguish them. We keep our own map keyed by
rootPath, recorded on switch-away, replayed on switch-back. Recorded shape:
- `tabs: ({type:"file", path, column} | {type:"terminal", column})[]` — full tab sequence in visual
  order, including the tmux terminal's position, with each tab's `viewColumn`.
- `active` — focus target: a file path, or the sentinel `"::terminal::"` (`TERMINAL_FOCUS_TARGET`)
  when the tmux terminal was focused.
- `panelTerminal` (an ad-hoc non-tmux panel shell existed) and `tmuxInPanel` (the tmux terminal lived
  in the bottom panel, i.e. exists but has no editor tab).
- `layout` — the object from **`vscode.getEditorLayout`** (orientation + nested group sizes); restored
  via **`vscode.setEditorLayout` *first*** so every recorded `viewColumn` (incl. a terminal-only
  bottom row) has a real group to land in. `tabGroups`' linear `viewColumn`s can't express the grid;
  this is why the split/row layout survives.

Restore order (`openRecordedTabs`): `setEditorLayout` → open each tab into its `viewColumn` (terminals
via `openTmuxSession`, files via `showTextDocument {preview:false, preserveFocus:true, viewColumn}`) →
recreate panel tmux if `tmuxInPanel` → recreate an ad-hoc panel shell if `panelTerminal` → else close
the panel → focus the recorded `active` target (the active file is opened **with its recorded column**
to avoid duplicating it into the active group).

### `openTmuxSession` additions (for restore use)

New optional `node` fields: `preserveFocus` (open the terminal visible but don't steal focus, so the
deliberate end-of-restore focus wins), `viewColumn` (recreate in a specific split — clamped by
`safeColumn` to an existing group), `panel` (recreate in the bottom panel, not the editor area),
`assumeCurrent` (skip the workspace-folder check; needed right after a folder swap when the folders
list hasn't propagated, else the terminal mis-routes to the floating-window path).

**Terminal trust by provenance, not name** (`createdTmuxTerminals: Set<string>`): a tmux terminal is
healthy only if it has a visible editor tab **or** this host created it (live panel terminals have no
tab, so the set vouches for them; a host restart clears it, which is exactly when revival happens).
Anything else matching by name is a ghost or a workspace-revived corpse — `show()` on those silently
no-ops and the button looks dead — so it's disposed and recreated. Stale revived terminals are also
swept at every anchored-workspace entry.

### Required setting / known gotchas solved during the build

- The window-level "untitled workspace" prompt is avoided by using a **saved** `.code-workspace` (not
  the bare single-folder→multi-root conversion, which produces an untitled workspace needing
  `window.confirmSaveUntitledWorkspace: false`).
- Ghost terminals (created into a not-yet-existing view column) → fixed by recreating the grid via
  `setEditorLayout` before opening, plus the `safeColumn` clamp and the provenance self-heal.
- Panel-located tmux carried across switches → fixed by disposing all non-target terminals on swap and
  recording `tmuxInPanel`.
- Split-tab duplication on restore → fixed by opening the active file with its recorded `viewColumn`.
- Focus jump during restore → fixed with `preserveFocus` on the terminal open + focusing the recorded
  target last.
- Folder-swap async race (terminal mis-routed to floating window) → fixed by awaiting
  `onDidChangeWorkspaceFolders` and passing `assumeCurrent`.

### Why it was abandoned (not because it didn't work)

It worked. It was shelved because the branch fell far behind master, which had meanwhile rewritten the
exact `_projectManager.open` / activation code it depends on (replaced the transient `autoStartTmux`
flag with a persistent `tmuxAutoOpened` set + first-open auto-open, removed `execAsync`, added the
deferred delete-open-project flow, auto-start-Claude, etc.). Rebasing was a re-implementation rather
than a merge, so the branch was dropped and this note kept for a clean re-implementation on current
master.
