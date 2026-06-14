/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as os from "os";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { commands, l10n, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { pendingDir } from "./pendingProjectStore";
import { validateBranchName } from "./gitUtils";
import { PROJECTS_BASE } from "../core/constants";
import { parseRepoFromRemote, bulkFetchDefaultBranches } from "./githubBulkFetch";

const execAsync = promisify(exec);

/**
 * Cheaply check whether the source's default branch is already at the GitHub
 * upstream tip (one batched GraphQL call + a local rev-parse). If so, the local
 * clone — which hardlinks the source's objects — already has that tip, and
 * clone.sh can check it out without the ~1.7s network fetch. Returns the default
 * branch name (so clone.sh can skip its own lookup) and whether the fetch is
 * skippable. Any failure (non-GitHub, offline, no local default ref) → don't skip.
 */
async function detectSourceCurrent(sourcePath: string): Promise<{ defaultBranch: string; skipFetch: boolean }> {
    try {
        const { stdout } = await execAsync(`git -C ${JSON.stringify(sourcePath)} remote get-url origin`, { timeout: 5000 });
        const parsed = parseRepoFromRemote(stdout.trim());
        if (!parsed) { return { defaultBranch: "", skipFetch: false }; }

        const heads = await bulkFetchDefaultBranches([ { rootPath: sourcePath, owner: parsed.owner, repo: parsed.repo } ]);
        const head = heads?.get(sourcePath);
        if (!head) { return { defaultBranch: "", skipFetch: false }; }

        const local = await execAsync(`git -C ${JSON.stringify(sourcePath)} rev-parse refs/heads/${head.defaultBranch}`, { timeout: 5000 })
            .then(r => r.stdout.trim())
            .catch(() => "");
        return { defaultBranch: head.defaultBranch, skipFetch: local !== "" && local === head.oid };
    } catch {
        return { defaultBranch: "", skipFetch: false };
    }
}

/**
 * Spawn a detached clone.sh script that clones sourcePath → targetDir on a new
 * branch and writes a pending-project file on success, so the project appears
 * in the list even if the user switched workspaces mid-run.
 */
export async function spawnDetachedClone(opts: {
    sourcePath: string;
    targetDir: string;
    branchName: string;
    pendingId: string;
    sessionId?: string;         // fork: source session to copy
    sessionSrcDir?: string;     // fork: ~/.claude/projects/<encoded-source>
    sessionDstDir?: string;     // fork: ~/.claude/projects/<encoded-target>
    invSessionToKill?: string;  // promote: tmux session name to kill after clone
    kind?: string;              // promote: "investigation" to remove after clone
}): Promise<void> {
    const { sourcePath, targetDir, branchName, pendingId,
            sessionId, sessionSrcDir, sessionDstDir,
            invSessionToKill, kind } = opts;

    const scriptPath = path.join(Container.context.extensionPath, "dist", "scripts", "clone.sh");
    const pendingFile = path.join(pendingDir(), `${pendingId}.json`);
    const logFile = path.join(os.homedir(), ".project-manager", "clone-logs", `${pendingId}.log`);
    const errorFile = path.join(pendingDir(), `${pendingId}.error`);

    // If the source is already at the upstream tip, clone.sh can skip the fetch.
    const { defaultBranch, skipFetch } = await detectSourceCurrent(sourcePath);

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
        defaultBranch,            // $13: GraphQL-resolved default branch ("" if unknown)
        skipFetch ? "1" : "",     // $14: source confirmed current → skip the fetch
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
