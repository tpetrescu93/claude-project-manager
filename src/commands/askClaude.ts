import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { commands, window, workspace } from "vscode";
import { Container } from "../core/container";

const execAsync = promisify(exec);

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
    try {
        await execAsync(`tmux has-session -t "=${sessionName}"`, { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

async function askClaude() {
    const editor = window.activeTextEditor;
    if (!editor) { return; }

    const rootPath = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) { return; }

    const sessionName = path.basename(rootPath).replace(/\./g, "-");
    if (!await tmuxSessionExists(sessionName)) {
        window.showErrorMessage("No Claude tmux session found for this project.");
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const selection = editor.selection;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    // Build context prefix: file:line or file:startLine-endLine + selected code
    let context: string;
    if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
        context = `${filePath}:${lineRange}\n\`\`\`\n${selectedText}\n\`\`\`\n`;
    } else {
        context = `${filePath}:${startLine}\n`;
    }

    const prompt = await window.showInputBox({
        prompt: "Ask Claude",
        placeHolder: "What do you want to ask?",
    });
    if (!prompt) { return; }

    const fullMessage = `${context}${prompt}`;

    // Escape for tmux send-keys: wrap in single quotes, escape single quotes inside
    const escaped = fullMessage.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t "=${sessionName}:" '${escaped}' Enter`, { timeout: 5000 });
}

export function registerAskClaude() {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.askClaude", askClaude)
    );
}
