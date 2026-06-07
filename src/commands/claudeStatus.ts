import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const lastPaneContentCache = new Map<string, string>();

export const claudeThinkingCache = new Map<string, boolean>();
export const claudeNeedsInputCache = new Map<string, boolean>();

export function isClaudeThinkingForPath(rootPath: string): boolean {
    return claudeThinkingCache.get(rootPath) ?? false;
}

export function isClaudeWaitingForInputForPath(rootPath: string): boolean {
    return claudeNeedsInputCache.get(rootPath) ?? false;
}

/**
 * Returns the pane content above the live input prompt `❯ `. Strips the
 * input line itself plus everything below it (separator, wall-clock line,
 * status bar, footer) so that:
 *   - typing in the prompt doesn't count as "Claude thinking"
 *   - the clock ticking every minute doesn't trigger a false positive
 */
function paneContentAboveInput(out: string): string {
    const lines = out.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[ i ].trimStart().startsWith("❯")) {
            return lines.slice(0, i).join("\n");
        }
    }
    return out;
}

export async function captureClaudeState(projectPath: string): Promise<{ thinking: boolean; needsInput: boolean }> {
    try {
        const sessionName = path.basename(projectPath).replace(/\./g, "-");
        const result = await execAsync(
            // `=name:` forces exact-match on the session (its active pane). Plain `-t name`
            // prefix-matches, so a project whose name prefixes another's would scrape the
            // wrong session; bare `=name` is rejected (capture-pane targets a pane, not a
            // session), so the trailing `:` (session's active window/pane) is required.
            `tmux capture-pane -t "=${sessionName}:" -p -S -20`,
            { timeout: 5000 }
        );
        const out = result.stdout;

        // Thinking = output above the input prompt changed since last poll.
        // When the spinner is active, the leading glyph cycles every ~100ms,
        // the elapsed-time counter ticks every second, and any content streaming
        // changes the buffer — all reliable signals of "Claude is doing work".
        // When idle, the content area is static (spinner gone) → no diff.
        const content = paneContentAboveInput(out);
        const prev = lastPaneContentCache.get(projectPath);
        lastPaneContentCache.set(projectPath, content);
        const thinking = prev !== undefined && prev !== content;

        // Picker footer detection. When a picker is active the selected option
        // is prefixed with `❯`, so paneContentAboveInput would strip the actual
        // picker footer (below the selection). Use the raw last 15 lines instead;
        // the picker footer always sits at the very bottom when active.
        // Match the stable ends of the footer ("Enter to select" … "Esc to cancel")
        // so it catches every picker variant — single-select uses "↑/↓ to navigate",
        // the AskUserQuestion multi-picker uses "Tab/Arrow keys to navigate", etc.
        // Single-line match (no newline in `.`) keeps it anchored to one footer line.
        const rawBottom = out.split("\n").slice(-15).join("\n");
        const needsInput = /Enter to select.*Esc to cancel/.test(rawBottom);

        return { thinking, needsInput };
    } catch {
        // No tmux session — drop any stored content so we don't compare across
        // a session restart.
        lastPaneContentCache.delete(projectPath);
        return { thinking: false, needsInput: false };
    }
}
