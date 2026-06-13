# Better Claude ↔ VS Code Integration: Detecting Selected Code

How to make a Claude Code CLI session (running in a tmux pane, one per project) aware of the
code the user has selected in the VS Code editor — so the user can refer to "this function" /
"the selection" and Claude knows what they mean.

This documents the mechanisms available, what each requires, and a ranked recommendation.

---

## Background

### Current behaviour (this extension)

The extension runs each project's Claude in a **persistent tmux session** (survives VS Code
reloads, workspace switches, crashes). Today, "Ask Claude from editor" works by **push via
keystroke injection**: the extension takes the editor selection (+ `file:line` context),
prepends it to the user's prompt, and injects the whole thing into the tmux pane with
`tmux set-buffer` + `paste-buffer` + `send-keys Enter`. Self-contained, window-independent,
no dependency on any Claude/VS Code connection.

### How the official integration works

Anthropic's own VS Code extension (`anthropic.claude-code`) provides selection awareness via a
**built-in "ide" MCP server over WebSocket**:

- The extension runs a local WebSocket server and writes `~/.claude/ide/<port>.lock` containing
  `{pid, workspaceFolders, ideName, transport:"ws", authToken}`. Auth is via the
  `x-claude-code-ide-authorization` header. Protocol is JSON-RPC 2.0 (MCP handshake).
- **Selection delivery is push-then-include**: the editor sends a `selection_changed`
  notification whenever the selection moves; the CLI tracks the latest and **auto-includes the
  current selection + active file path on every prompt you send** (the transcript shows
  `⧉ Selected N lines from <file>`). This auto-on-every-turn behaviour is the thing users want.
- **Connection discovery**: the CLI uses the `CLAUDE_CODE_SSE_PORT` env var (the extension sets
  it on the integrated terminal's environment), falling back to scanning `~/.claude/ide/*.lock`
  and matching `workspaceFolders` to the session cwd. `claude --ide` auto-connects **iff exactly
  one** valid IDE is available.

### The facts that constrain every option

These were verified against the docs, the installed extension bundle, and live observation:

1. **The IDE port is dynamic.** It re-rolls every time the extension re-activates or rebinds
   (observed changing `41288 → 32871 → 19532` within seconds). In this extension's model, **every
   project switch reloads the window → the extension re-activates → the port changes**.
2. **A running session's environment is frozen.** A tmux Claude's `CLAUDE_CODE_SSE_PORT` is fixed
   at launch and can never track the changing port. Our tmux sessions also start *outside* VS
   Code's integrated terminal, so they don't inherit the env var at all.
3. **`/ide` re-scans lockfiles live** (that's why it can reconnect), but it takes **no argument**
   (`/ide 1`, `/ide "Visual Studio Code"` are ignored → "IDE selection cancelled") and shows an
   **interactive picker** that cannot be pre-selected non-interactively.
4. **Push vs pull.** Only the built-in IDE integration can auto-inject selection into every
   prompt. A generic MCP server is **pull-on-demand** — Claude calls a tool only when it judges
   the request relevant; the server cannot force context into a turn.
5. **The IDE protocol is internal, not a third-party surface.** Anthropic ships the editor side
   themselves (VS Code, JetBrains); the docs call the `ide` MCP server internal plumbing
   ("hidden… nothing to configure"). There is **no published spec or SDK**. The only third-party
   implementation (`coder/claudecode.nvim`) reverse-engineered it (`PROTOCOL.md`). **MCP** is the
   officially supported third-party surface. So anything that speaks the IDE protocol directly is
   riding an undocumented, unstable wire format that a CLI update can break without notice.

---

## Options

### Option 1 — Keystroke injection (current "Ask Claude" push)

**What it is.** Extension reads the selection, prepends `file:line` + fenced code to the prompt,
injects into the tmux pane (`set-buffer` → `paste-buffer` → `send-keys Enter`).

**Research.** Works because it drives the Claude TUI directly and targets the project's session
by name — independent of any IDE connection, port, or window lifecycle.

**What we'd need.** Already built.

**Pros.** Reliable, window-independent, survives reloads, no protocol dependency, addresses the
exact (project → session) routing the official channel lacks for out-of-IDE sessions.
**Cons.** Editor-initiated push only — the user triggers from the editor; Claude doesn't passively
"know" the selection when the user is typing *in Claude*. One-shot, not ambient.

### Option 2 — Official IDE integration via `CLAUDE_CODE_SSE_PORT` at launch

**What it is.** When launching a project's Claude in tmux, read the matching `~/.claude/ide/*.lock`,
export `CLAUDE_CODE_SSE_PORT=<that port>` so the CLI auto-connects to that window's IDE server.

**Research.** Works *at the instant of launch* and is the only thing that disambiguates among
multiple windows (the env var names an exact port, bypassing the picker). But the port is dynamic
(fact 1) and the env is frozen (fact 2), so the connection dies on the **first reload/switch-back**
and cannot recover. Must be set at session *creation* (`tmux new-session -e …`), not attach.

**What we'd need.** Lockfile lookup + workspace match + set the env var in the session-launch
command (in `openTmuxSession` / `clone.sh`).

**Pros.** Uses the official auto-push selection behaviour; deterministic at launch.
**Cons.** Breaks on the first project switch (port churn) and can't reconnect. Effectively useless
for a persistent, reload-heavy session. Eager-clone sessions start before any window exists → no
lockfile → no connection.

### Option 3 — Auto-inject `/ide` on project open

**What it is.** On project open, inject `/ide` into the tmux pane via `send-keys` so the (already
running) session re-scans lockfiles and reconnects to the freshly-reloaded window's current port.

**Research.** `/ide`'s live re-scan is exactly the dynamic-port recovery the frozen env var can't
do. But `/ide` has no argument (fact 3) and shows an interactive picker. With **one** VS Code
window open (the common case here), the picker is unambiguous and this is viable; with **multiple**
windows or stale lockfiles, blind-driving the picker (`/ide` + arrow + Enter) is brittle —
hardcoded arrow counts depend on menu composition, render timing, and connection state, with a
silent risk of selecting the *wrong* window. Observed: bare `/ide` attempts returned "IDE selection
cancelled", so it isn't even behaving trivially in practice.

**What we'd need.** `send-keys '/ide'` on open; if a picker appears, scripted navigation keys
(only safe after empirically confirming the single-match picker layout); injection must wait for an
idle session (mid-turn input queues).

**Pros.** Uses official auto-push; recovers across reloads (unlike Option 2).
**Cons.** Brittle TUI choreography; only safe in the single-window case; must verify picker
behaviour; re-runs on every switch; silent mis-connect risk.

### Option 4 — Our own MCP server (HTTP, stable port)

**What it is.** The extension hosts an MCP server over streamable HTTP on a **fixed** port, exposing
tools backed by `vscode.window.activeTextEditor` — `get_current_selection`, `get_active_file`,
`get_diagnostics`. Claude sessions are configured once (`claude mcp add --transport http …` or a
user-level `.mcp.json`) to use it.

**Research.** The stable port sidesteps the dynamic-port churn and the picker entirely — after a
reload the server restarts on the same port and Claude reconnects on its next tool call. But MCP is
**pull-on-demand** (fact 4): Claude calls `get_current_selection` only when it decides the request
warrants it — it does **not** auto-attach the selection to every prompt. A `CLAUDE.md` instruction
("when the user says 'this'/'the selection', call `get_current_selection`") nudges it but doesn't
guarantee every-turn inclusion.

**What we'd need.** Build the MCP HTTP server in the extension (`@modelcontextprotocol/sdk`), pick a
stable port + collision handling, the selection/active-file/diagnostics tools, and a one-time MCP
registration for sessions. Single-window means the "active editor" the tools read is unambiguously
the project in view.

**Pros.** Officially supported surface (MCP) — version-stable, won't break on CLI updates. Stable
port → no churn, no picker, survives reloads. Self-contained.
**Cons.** Pull-on-demand, not auto-push — so not the seamless "it just knows on every prompt"
behaviour. The server lives in the ext host (reloads on switch); fixed port means a brief gap
mid-reload, Claude retries.

### Option 5 — Persistent IDE-protocol relay daemon ("pretend to be the IDE")

**What it is.** A standalone, always-on daemon (e.g. launchd-managed) on a **fixed** port that
implements enough of the IDE WebSocket protocol to *be* the IDE from Claude's perspective: MCP
handshake, advertise tools, answer `getCurrentSelection`/`getDiagnostics`, emit `selection_changed`,
and write its own `~/.claude/ide/<fixedport>.lock`. Claude connects to the relay (which never dies).
The VS Code extension is a **client** of the relay, pushing live selection/active-file/diagnostics.

**Research.** This is the only design that delivers **both** auto-push selection **and** reload
stability:
- Claude ↔ relay is stable (fixed port, daemon never dies) — Claude connects once and stays
  connected across VS Code reloads. This also revives `CLAUDE_CODE_SSE_PORT`: it only failed because
  the *real* port churned; pointed at a fixed relay port, the frozen env var is correct forever.
- Extension ↔ relay: on a reload only this link blips (~1s); Claude's session is untouched. The new
  extension instance reconnects and resumes pushing.
- Because the relay speaks the IDE protocol, it can send `selection_changed` → Claude auto-includes
  the selection on every prompt (the real behaviour, not pull-on-demand).

Must be built as the relay **terminating** Claude's connection (owning the protocol session), not a
transparent byte-proxy (Claude → relay → real extension server) — a pass-through desyncs the stateful
MCP session when the backend restarts on reload.

**What we'd need.** Implement the reverse-engineered IDE/MCP server protocol (reference:
`coder/claudecode.nvim` `PROTOCOL.md` + its server) as a daemon: lockfile + auth token, MCP
handshake, `getCurrentSelection`/`getDiagnostics` responses, `selection_changed` notifications. Plus
a minimal extension-side client that pushes the active selection to the daemon. Plus session launch
wiring (`CLAUDE_CODE_SSE_PORT=<relay port>`).

**Pros.** The only option that is both **auto-push** and **reload-stable**. Fixed port resolves all
churn/picker problems.
**Cons.** Highest effort. Rides an **undocumented, reverse-engineered** protocol (fact 5) — a CLI
update can change the wire format and break it, with no auto-tracking. Standing maintenance burden.
A daemon to run/manage.

### Option 6 — `UserPromptSubmit` hook + extension-written selection file

**What it is.** The extension writes the current editor selection to a known location on every
selection-change (a small file, e.g. `~/.claude/current-selection.json`, or a fixed-port local HTTP
endpoint). A Claude Code `UserPromptSubmit` hook reads that on **every prompt** and injects it as
context, so Claude always sees the live selection without the user pasting it or asking it to look.

**Research (verified against the official hooks docs + CLI).**
- `UserPromptSubmit` hooks can **add context** to the prompt: either via plain **stdout** or a
  structured JSON object — `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
  "additionalContext": "…"}}` — returned on `exit 0`. The text reaches the model **on the same turn**
  as a system reminder, before the prompt is processed.
- The hook **runs on every prompt submission** (including slash commands) and is an **arbitrary shell
  command**, so it can `cat` a file or `curl` a localhost endpoint. It receives the prompt + cwd as
  JSON on stdin.
- This makes it **push-like and reliable** — the selection is injected automatically every turn,
  with no dependence on Claude *deciding* to call a tool (the failure mode of Option 4) and no
  reverse-engineered protocol (the risk of Option 5).
- Limits/gotchas: `additionalContext` is capped at ~10,000 chars (longer is spilled to a file with a
  preview); the hook can't read VS Code state itself (hence the extension must write the selection
  out); and there is a known bug ([#40216](https://github.com/anthropics/claude-code/issues/40216))
  where `additionalContext` may **accumulate across turns** instead of being per-turn — mitigate by
  keeping the injected text small and/or gating injection on a non-empty selection.

**What we'd need.**
- Extension: on `window.onDidChangeTextEditorSelection`, write `{file, startLine, endLine, text}` of
  the active editor to `~/.claude/current-selection.json` (clear/empty it when selection is empty).
- A `UserPromptSubmit` hook in `~/.claude/settings.json` that reads that file and emits the selection
  as `additionalContext` (only when non-empty), `exit 0`.

**Pros.** Auto-push every prompt (the behaviour users actually want) **on officially supported
surfaces** (hooks + our own file) — no reverse-engineered protocol, no CLI-update breakage risk.
Stable: file-based, immune to the dynamic-port churn that defeats Options 2/3/5's env path. Simple —
no daemon, no protocol server.
**Cons.** Injects selection text into every prompt (minor token cost / noise; gate on non-empty).
Reads the *active* window's selection — correct for single-window usage, but a background project's
session would see the foreground project's selection. Subject to the #40216 accumulation bug until
fixed.

### Option 7 — On-demand slash command / MCP prompt that injects the selection

**What it is.** Reuse the same extension-written selection file as Option 6, but pull it in only when
the user asks: a custom slash command (`.claude/commands/sel.md` whose body runs
`` !cat ~/.claude/current-selection.json `` and prepends it) or an MCP `prompts` entry. The user
types `/sel <question>` and the current selection is injected for that one turn.

**Research.** Custom slash commands support embedding shell output (the `` ! `` prefix) and
`$ARGUMENTS`; MCP servers can expose `prompts` (user-invoked, distinct from model-invoked `tools`).
Both are officially supported, user-triggered surfaces. This sits between Options 4 and 6:
- vs **Option 4 (MCP tool):** triggering is **reliable** — the *user* invokes it, so there's no "will
  Claude decide to call the tool" gamble.
- vs **Option 6 (hook, every prompt):** it's **opt-in per turn** — the selection rides along only when
  asked, avoiding Option 6's per-prompt token cost/noise and the #40216 accumulation bug.

**What we'd need.** The same extension-side selection writer as Option 6, plus a one-file custom
command (or an MCP `prompts` entry) that reads it. No daemon, no port, no protocol.

**Pros.** Officially supported and trivially simple. Reliable triggering (explicit). No per-prompt
overhead. Shares the Option 6 plumbing, so it can ship alongside it.
**Cons.** **Manual** — not ambient; the user must type `/sel` each time they want the selection
considered. Same active-window-selection caveat as Option 6.

---

## Conclusion

There **is** an option that is both "auto-attach selection to every prompt" *and* on officially
supported surfaces: **Option 6** — a `UserPromptSubmit` hook that injects an extension-written
selection file on every turn. It gets the auto-push behaviour of the private IDE integration using
only public mechanisms (hooks + our own file), without the reverse-engineered protocol of Option 5
or the dynamic-port fragility of Options 2/3.

All three viable designs share **one piece of plumbing** — the extension writing the active
selection to a file (`~/.claude/current-selection.json`) on selection-change — and differ only in how
Claude consumes it:
- **Option 6 (hook + selection file)** — auto-push every prompt; ambient "Claude always knows what
  I've selected". The recommended path for ambient awareness.
- **Option 7 (slash command / MCP prompt)** — same file, pulled in on demand (`/sel`); reliable
  trigger, no per-prompt overhead, no accumulation bug. The right path if you'd rather opt in per
  turn than carry the selection on every prompt. Ships alongside Option 6 for free.
- **Option 1 (keystroke injection)** — already built; the explicit editor-initiated "ask about this
  selection *and send a prompt*" action. Complements the above.

Because 6 and 7 share plumbing, shipping the selection-file writer + both a hook and a `/sel` command
gives the full spectrum (ambient *and* on-demand) at minimal extra cost.

The others are dominated:
- **Option 4 (MCP server)** gives Claude the *ability* to fetch the selection but relies on Claude
  *deciding* to call the tool — unreliable for ambient awareness (it may never call it, or not
  realise a selection exists). Useful only if you want selection access as one tool among many,
  not as default context.
- **Option 5 (relay daemon)** achieves the same auto-push as Option 6 but via an undocumented,
  maintenance-bearing protocol — redundant now that Option 6 reaches the same outcome on supported
  surfaces.
- **Options 2 and 3** are fundamentally limited by the dynamic IDE port and aren't viable primaries
  for a persistent-tmux setup.

---

## Ranked options

1. **Option 6 — `UserPromptSubmit` hook + extension-written selection file.** *Recommended.* The only
   design that is both auto-push (selection injected every prompt, no tool-call guessing) **and** on
   officially supported surfaces (hooks + our own file) — so no reverse-engineered protocol and no
   CLI-update breakage. Stable (file-based, no port churn), simple (no daemon). Caveats: per-prompt
   token cost (gate on non-empty selection); reads the active window's selection; the #40216
   accumulation bug until fixed.

2. **Option 7 — On-demand slash command / MCP prompt.** *Recommended companion to Option 6.* Same
   selection-file plumbing, pulled in only when the user types `/sel` — reliable trigger, officially
   supported, no per-prompt cost or accumulation bug. Trade-off: manual, not ambient. Ship it
   alongside Option 6 to cover both ambient and opt-in.

3. **Option 1 — Keystroke injection (current).** *Keep as the explicit-ask path.* Already built,
   reliable, window-independent. One-shot editor-initiated push (selection + a prompt), not ambient.
   Complements Options 6/7 rather than competing.

4. **Option 4 — MCP HTTP server (stable port).** *Supported and stable, but pull-on-demand.* Gives
   Claude the ability to fetch the selection, but relies on Claude deciding to call the tool —
   unreliable for ambient awareness. Worth it only if you also want other editor tools exposed.

5. **Option 5 — Persistent IDE-protocol relay.** *Capable but redundant.* Achieves auto-push +
   stability, but via an undocumented, maintenance-bearing protocol — superseded by Option 6, which
   reaches the same result on supported surfaces.

6. **Option 3 — Auto-inject `/ide` on open.** *Viable only single-window.* Recovers across reloads but
   brittle TUI choreography with silent mis-connect risk; depends on picker layout/timing.

7. **Option 2 — `CLAUDE_CODE_SSE_PORT` at launch.** *Not viable for persistent sessions.* Works only at
   launch; dies on the first reload (port churn, frozen env) with no recovery.

---

### Sources

- [Claude Code for VS Code (official docs)](https://code.claude.com/docs/en/vs-code)
- [Claude Code IDE protocol (reverse-engineered) — coder/claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)
- [CVE-2025-52882 — Claude Code IDE WebSocket auth (mechanism details)](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/)
- Local verification: `~/.claude/ide/<port>.lock` contents; `anthropic.claude-code` extension bundle (`CLAUDE_CODE_SSE_PORT`, `authToken`, `getCurrentSelection`, `selection_changed`, `x-claude-code-ide-authorization`); observed dynamic port churn; `/ide` argument/picker behaviour.
