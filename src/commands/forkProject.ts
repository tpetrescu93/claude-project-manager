/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, l10n, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { spawnDetachedClone } from "./cloneProject";
import { validateBranchName, run } from "./gitUtils";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Claude stores each session under ~/.claude/projects/<cwd with / replaced by ->.
 * Leading slash becomes a leading dash (kept, not stripped) — matches the real
 * on-disk directory names.
 */
export function encodeProjectDir(rootPath: string): string {
    return rootPath.replace(/\//g, "-");
}

/**
 * Returns the newest session id (jsonl filename without extension) for a project,
 * or undefined if the project has no Claude session on disk.
 */
/**
 * Heuristic: is this jsonl one of our headless automation sessions (pr-slack /
 * merge-react)? Those are normally cleaned up after running, but an already-polluted
 * dir or an interrupted run can leave one behind — and it must never be the session
 * we fork/resume. Checks the head of the file for the known automation prompt.
 */
function isAutomationSession(file: string): boolean {
    try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.allocUnsafe(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        return /\bpr-slack(-react)? skill\b/.test(buf.toString("utf8", 0, n));
    } catch {
        return false;
    }
}

export function latestSessionId(rootPath: string): string | undefined {
    const dir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(rootPath));
    let entries: string[];
    try {
        entries = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    } catch {
        return undefined;
    }
    // Newest first, skipping our own automation transcripts.
    const sorted = entries
        .map(f => { try { return { f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return undefined; } })
        .filter((x): x is { f: string; mtimeMs: number } => !!x)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { f } of sorted) {
        if (isAutomationSession(path.join(dir, f))) { continue; }
        return f.replace(/\.jsonl$/, "");
    }
    return undefined;
}

/**
 * Copies the source session's transcript (and subagent dir) into the target
 * project's Claude dir, rewriting every entry's `cwd` field to the target path
 * so `claude --resume` operates in the new folder rather than staying pinned to
 * the source. Mirrors the `move` skill's jq-based cwd rewrite. Returns false if
 * the source transcript couldn't be found.
 */
export async function copySessionWithCwdRewrite(sourcePath: string, targetPath: string, sessionId: string): Promise<boolean> {
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

async function doFork(sourcePath: string, sourceName: string, repoName: string | undefined) {
    const sessionId = latestSessionId(sourcePath);
    if (!sessionId) {
        window.showWarningMessage(l10n.t("No Claude session found for this project to fork. Use \"Clone to New Project\" for a plain clone."));
        return;
    }

    const input = await window.showInputBox({
        prompt: l10n.t("New branch name"),
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

    const folderName = repoName ? `${repoName}-${newName}` : newName;
    const targetDir = path.join(path.dirname(sourcePath), folderName);
    const pendingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionSrcDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(sourcePath));
    const sessionDstDir = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(targetDir));

    spawnDetachedClone({
        sourcePath, targetDir, branchName: newName, pendingId,
        sessionId, sessionSrcDir, sessionDstDir,
    });
    window.showInformationMessage(
        l10n.t("Forking in the background — \"{0}\" will appear in Projects when done.", newName)
    );
}

async function forkProject(node: ProjectNode, projectStorage: ProjectStorage) {
    const sourcePath = node.preview.path;
    const sourceProject = projectStorage.getAll().find(
        p => path.resolve(p.rootPath) === path.resolve(sourcePath)
    );
    const sourceName = sourceProject?.name ?? path.basename(sourcePath);
    await doFork(sourcePath, sourceName, sourceProject?.repoName);
}

async function forkArchivedProject(node: import("../sidebar/nodes").ArchivedProjectNode) {
    const sourcePath = node.preview.path;
    await doFork(sourcePath, node.preview.name, undefined);
}

export function registerForkProject(projectStorage: ProjectStorage) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.forkProject", (node: ProjectNode) => forkProject(node, projectStorage)),
        commands.registerCommand("_projectManager.forkArchivedProject", (node: import("../sidebar/nodes").ArchivedProjectNode) => forkArchivedProject(node)),
    );
}
