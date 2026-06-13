/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { commands, l10n, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { pendingDir } from "./pendingProjectStore";
import { validateBranchName } from "./gitUtils";
import { PROJECTS_BASE } from "../core/constants";

/**
 * Spawn a detached clone.sh script that clones sourcePath → targetDir on a new
 * branch and writes a pending-project file on success, so the project appears
 * in the list even if the user switched workspaces mid-run.
 */
export function spawnDetachedClone(opts: {
    sourcePath: string;
    targetDir: string;
    branchName: string;
    pendingId: string;
    sessionId?: string;         // fork: source session to copy
    sessionSrcDir?: string;     // fork: ~/.claude/projects/<encoded-source>
    sessionDstDir?: string;     // fork: ~/.claude/projects/<encoded-target>
    invSessionToKill?: string;  // promote: tmux session name to kill after clone
    kind?: string;              // promote: "investigation" to remove after clone
}) {
    const { sourcePath, targetDir, branchName, pendingId,
            sessionId, sessionSrcDir, sessionDstDir,
            invSessionToKill, kind } = opts;

    const scriptPath = path.join(Container.context.extensionPath, "dist", "scripts", "clone.sh");
    const pendingFile = path.join(pendingDir(), `${pendingId}.json`);
    const logFile = path.join(os.homedir(), ".project-manager", "clone-logs", `${pendingId}.log`);
    const errorFile = path.join(pendingDir(), `${pendingId}.error`);

    const args = [
        sourcePath,
        targetDir,
        branchName,
        pendingFile,
        logFile,
        errorFile,
        pendingId,
        sessionId ?? "",
        sessionSrcDir ?? "",
        sessionDstDir ?? "",
        invSessionToKill ?? "",
        kind ?? "",
    ];

    const child = spawn("bash", [ scriptPath, ...args ], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
}

async function cloneProject(node: ProjectNode, projectStorage: ProjectStorage) {
    const sourcePath = node.preview.path;

    const input = await window.showInputBox({
        prompt: l10n.t("Branch name for the new project"),
        placeHolder: "my-feature-branch",
        validateInput: validateBranchName
    });
    if (!input) { return; }
    const branchName = input.trim();

    // Use the stored repoName if available so the folder is "paydays-api-<branch>"
    // even when cloning from a worktree whose folder already has the prefix.
    const sourceProject = projectStorage.getAll().find(
        p => path.resolve(p.rootPath) === path.resolve(sourcePath)
    );
    const repoName = sourceProject?.repoName ?? path.basename(sourcePath);
    // Working copies always land in the projects base, regardless of where the
    // canonical source repo lives (e.g. the .repos folder).
    const targetDir = path.join(PROJECTS_BASE, `${repoName}-${branchName}`);
    const pendingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    spawnDetachedClone({ sourcePath, targetDir, branchName, pendingId });
    window.showInformationMessage(
        l10n.t("Cloning in the background — \"{0}\" will appear in Projects when done.", path.basename(targetDir))
    );
}

export function registerCloneProject(projectStorage: ProjectStorage) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.cloneProject", (node: ProjectNode) => cloneProject(node, projectStorage))
    );
}
