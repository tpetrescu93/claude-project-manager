/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const SELECTION_FILE = path.join(os.homedir(), ".claude", "current-selection.json");
const DEBOUNCE_MS = 200;

let debounceTimer: NodeJS.Timeout | undefined;

/**
 * Write the active editor's selection (or clear it) to the selection file. A
 * non-file editor or empty selection writes `{}` so the hook injects nothing.
 * Best-effort — a write failure must never disrupt the editor.
 */
function snapshot(editor: vscode.TextEditor | undefined): void {
    try {
        fs.mkdirSync(path.dirname(SELECTION_FILE), { recursive: true });
        if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file") {
            fs.writeFileSync(SELECTION_FILE, "{}\n");
            return;
        }
        const sel = editor.selection;
        const doc = editor.document;
        const payload = {
            file: doc.uri.fsPath,
            startLine: sel.start.line + 1,   // 1-based, matching editor gutter
            endLine: sel.end.line + 1,
            text: doc.getText(sel),
        };
        fs.writeFileSync(SELECTION_FILE, JSON.stringify(payload) + "\n");
    } catch { /* best-effort */ }
}

function schedule(editor: vscode.TextEditor | undefined): void {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => snapshot(editor), DEBOUNCE_MS);
}

/**
 * Mirrors the active editor's selection to `~/.claude/current-selection.json` so a
 * `UserPromptSubmit` hook can inject it into Claude on every prompt — "ambient
 * selection awareness" (see FORK_CLAUDE_SELECTION_INTEGRATION.md, Option 6).
 * Debounced because cursor moves fire `onDidChangeTextEditorSelection` constantly;
 * empty selection / non-file editor clears the file.
 */
export function registerSelectionTracker(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => schedule(e.textEditor)),
        vscode.window.onDidChangeActiveTextEditor(editor => schedule(editor)),
        { dispose: () => { if (debounceTimer) { clearTimeout(debounceTimer); } } },
    );
    snapshot(vscode.window.activeTextEditor);
}
