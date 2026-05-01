/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { commands, l10n, ProgressLocation, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function run(cmd: string, cwd: string): Promise<string> {
    const { stdout } = await execAsync(cmd, { cwd });
    return stdout.trim();
}

async function getDefaultBranch(cwd: string): Promise<string> {
    try {
        const ref = await run("git symbolic-ref refs/remotes/origin/HEAD", cwd);
        return ref.replace("refs/remotes/origin/", "");
    } catch {
        // Fallback: try common branch names
        for (const branch of [ "main", "master", "develop" ]) {
            try {
                await run(`git rev-parse --verify origin/${branch}`, cwd);
                return branch;
            } catch {
                continue;
            }
        }
        throw new Error("Could not detect default branch");
    }
}

async function cloneProject(node: ProjectNode, projectStorage: ProjectStorage) {
    const sourcePath = node.preview.path;
    const sourceName = path.basename(sourcePath);
    const parentDir = path.dirname(sourcePath);

    const input = await window.showInputBox({
        prompt: l10n.t("Branch name for the new project"),
        placeHolder: "my-feature-branch",
        validateInput: (value) => {
            if (!value || !value.trim()) {
                return l10n.t("Branch name is required");
            }
            if (/[^a-zA-Z0-9\-_./]/.test(value)) {
                return l10n.t("Invalid characters in branch name");
            }
            return undefined;
        }
    });

    if (!input) { return; }

    const branchName = input.trim();
    const targetDir = path.join(parentDir, `${sourceName}-${branchName}`);

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Cloning project..."),
        cancellable: false
    }, async (progress) => {
        try {
            // 1. rsync excluding node_modules
            progress.report({ message: l10n.t("Copying files...") });
            await run(`rsync -a --exclude='node_modules/' --exclude='.venv/' --exclude='venv/' "${sourcePath}/" "${targetDir}/"`, parentDir);

            // 2. Clean git locks
            await run(`rm -f .git/index.lock .git/refs/heads/*.lock`, targetDir);

            // 3. Git: clean, checkout default branch, pull, create new branch
            progress.report({ message: l10n.t("Setting up git...") });
            const defaultBranch = await getDefaultBranch(targetDir);
            await run("git clean -fd", targetDir);
            await run("git fetch origin", targetDir);
            await run(`git checkout -f ${defaultBranch}`, targetDir);
            await run(`git reset --hard origin/${defaultBranch}`, targetDir);
            await run(`git checkout -b ${branchName}`, targetDir);

            // 4. Install dependencies if lockfile exists
            try {
                const { stdout: hasYarnLock } = await execAsync(`test -f yarn.lock && echo yes || echo no`, { cwd: targetDir });
                const { stdout: hasPackageLock } = await execAsync(`test -f package-lock.json && echo yes || echo no`, { cwd: targetDir });

                if (hasYarnLock.trim() === "yes" || hasPackageLock.trim() === "yes") {
                    progress.report({ message: l10n.t("Installing dependencies...") });
                    await run("bun install", targetDir);
                    await run("rm -f bun.lock bun.lockb", targetDir);
                }
            } catch {
                // bun not installed or install failed — not fatal
            }

            // 5. Register in Project Manager
            const projectName = path.basename(targetDir);
            if (!projectStorage.exists(projectName)) {
                projectStorage.push(projectName, targetDir);
                projectStorage.save();
            }

            window.showInformationMessage(l10n.t("Project cloned to {0}", targetDir));
        } catch (error) {
            window.showErrorMessage(l10n.t("Failed to clone project: {0}", error.message));
        }
    });
}

export function registerCloneProject(projectStorage: ProjectStorage) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.cloneProject", (node: ProjectNode) => cloneProject(node, projectStorage))
    );
}
