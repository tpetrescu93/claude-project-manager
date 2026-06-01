/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, l10n, ProgressLocation, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { performClone, validateBranchName, run } from "./cloneProject";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Claude stores each session under ~/.claude/projects/<cwd with / replaced by ->.
 * Leading slash becomes a leading dash (kept, not stripped) — matches the real
 * on-disk directory names.
 */
function encodeProjectDir(rootPath: string): string {
    return rootPath.replace(/\//g, "-");
}

/**
 * Returns the newest session id (jsonl filename without extension) for a project,
 * or undefined if the project has no Claude session on disk.
 */
function latestSessionId(rootPath: string): string | undefined {
    const dir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(rootPath));
    let entries: string[];
    try {
        entries = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    } catch {
        return undefined;
    }
    let best: { id: string; mtimeMs: number } | undefined;
    for (const f of entries) {
        try {
            const stat = fs.statSync(path.join(dir, f));
            if (!best || stat.mtimeMs > best.mtimeMs) {
                best = { id: f.replace(/\.jsonl$/, ""), mtimeMs: stat.mtimeMs };
            }
        } catch { /* skip */ }
    }
    return best?.id;
}

/**
 * Copies the source session's transcript (and subagent dir) into the target
 * project's Claude dir, rewriting every entry's `cwd` field to the target path
 * so `claude --resume` operates in the new folder rather than staying pinned to
 * the source. Mirrors the `move` skill's jq-based cwd rewrite. Returns false if
 * the source transcript couldn't be found.
 */
async function copySessionWithCwdRewrite(sourcePath: string, targetPath: string, sessionId: string): Promise<boolean> {
    const srcDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(sourcePath));
    const dstDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(targetPath));
    const srcJsonl = path.join(srcDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(srcJsonl)) { return false; }

    fs.mkdirSync(dstDir, { recursive: true });

    // jq per line: only rewrite the cwd key; leave embedded paths in message
    // history intact. `claude --resume` reads cwd from the transcript, so this
    // is what unpins the resumed session from the source folder.
    const dstJsonl = path.join(dstDir, `${sessionId}.jsonl`);
    await run(
        `jq -c --arg cwd ${shellQuote(targetPath)} 'if has("cwd") then .cwd = $cwd else . end' ${shellQuote(srcJsonl)} > ${shellQuote(dstJsonl)}`,
        srcDir
    );

    // Subagent transcripts live under <id>/ (with nested dirs and, occasionally,
    // non-regular files like IPC sockets). Best-effort: recurse, rewrite cwd in
    // every .jsonl, copy regular files verbatim, skip anything else (sockets,
    // fifos, symlinks). A failure here must not abort the fork — the main
    // transcript is what `--resume` needs.
    const srcSub = path.join(srcDir, sessionId);
    if (fs.existsSync(srcSub) && fs.statSync(srcSub).isDirectory()) {
        try {
            await copyTreeWithCwdRewrite(srcSub, path.join(dstDir, sessionId), targetPath);
        } catch {
            // non-fatal — subagent history is supplementary to resume
        }
    }
    return true;
}

/**
 * Recursively copies a directory tree, rewriting `cwd` in every `.jsonl`,
 * copying regular files verbatim, and skipping non-regular entries
 * (sockets, fifos, symlinks).
 */
async function copyTreeWithCwdRewrite(srcDir: string, dstDir: string, targetPath: string): Promise<void> {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
            await copyTreeWithCwdRewrite(s, d, targetPath);
        } else if (entry.isFile()) {
            if (entry.name.endsWith(".jsonl")) {
                await run(
                    `jq -c --arg cwd ${shellQuote(targetPath)} 'if has("cwd") then .cwd = $cwd else . end' ${shellQuote(s)} > ${shellQuote(d)}`,
                    srcDir
                );
            } else {
                fs.copyFileSync(s, d);
            }
        }
        // else: socket / fifo / symlink — skip
    }
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

async function forkProject(node: ProjectNode, projectStorage: ProjectStorage) {
    const sourcePath = node.preview.path;
    const sessionId = latestSessionId(sourcePath);

    if (!sessionId) {
        window.showWarningMessage(l10n.t("No Claude session found for this project to fork. Use \"Clone to New Project\" for a plain clone."));
        return;
    }

    const sourceName = path.basename(sourcePath);
    const input = await window.showInputBox({
        prompt: l10n.t("New project name (edit to fork into a new folder + branch)"),
        value: sourceName,
        valueSelection: [ 0, sourceName.length ],
        validateInput: (value) => {
            const base = validateBranchName(value);
            if (base) { return base; }
            if (value.trim() === sourceName) {
                return l10n.t("Choose a different name from the source project.");
            }
            return undefined;
        }
    });
    if (!input) { return; }
    const newName = input.trim();

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Forking project + Claude session..."),
        cancellable: false
    }, async (progress) => {
        try {
            // newName is both the new folder name and the new git branch.
            const targetDir = await performClone(sourcePath, newName, projectStorage, progress, newName);

            progress.report({ message: l10n.t("Copying Claude session...") });
            const copied = await copySessionWithCwdRewrite(sourcePath, targetDir, sessionId);
            if (!copied) {
                window.showWarningMessage(l10n.t("Project forked, but the Claude session transcript could not be copied."));
                return;
            }

            // Start the resumed Claude in a DETACHED tmux session — no VS Code
            // terminal in the current (unrelated) workspace. When the user later
            // switches to the forked project and runs "Open Tmux Session", it
            // `tmux attach`es to this already-running, resumed session.
            // `bash -lic` as the session command loads the profile so claude is on PATH.
            progress.report({ message: l10n.t("Starting resumed Claude session...") });
            const sessionName = path.basename(targetDir).replace(/\./g, "-");
            const resumeCmd = `claude --resume ${sessionId} --dangerously-skip-permissions`;
            await run(
                `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(targetDir)} bash -lic ${shellQuote(resumeCmd)} 2>/dev/null || true`,
                targetDir
            );

            const choice = await window.showInformationMessage(
                l10n.t("Forked to {0} — Claude is resuming in a background tmux session.", path.basename(targetDir)),
                l10n.t("Open Project")
            );
            if (choice) {
                commands.executeCommand("_projectManager.open", targetDir, path.basename(targetDir));
            }
        } catch (error) {
            window.showErrorMessage(l10n.t("Failed to fork project: {0}", error.message));
        }
    });
}

export function registerForkProject(projectStorage: ProjectStorage) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.forkProject", (node: ProjectNode) => forkProject(node, projectStorage))
    );
}
