/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { commands, l10n, ProgressLocation, window } from "vscode";
import { Container } from "../core/container";
import { REPOS_BASE } from "../core/constants";
import { ProjectNode } from "../sidebar/nodes";
import { getGitRepoList, addToGitRepoList, removeFromGitRepoList } from "./gitRepoStore";

const execAsync = promisify(exec);

/** Canonical git repos — the curated, extension-managed list shown in the Git view. */
export function listCanonicalRepos(): string[] {
    return getGitRepoList();
}

/** Derive the repo folder name from a git remote URL (strips trailing .git). */
function repoNameFromUrl(url: string): string {
    const m = url.trim().replace(/\.git$/, "").match(/[/:]([^/:]+)$/);
    return m ? m[1] : "";
}

async function addGitRepo() {
    const url = await window.showInputBox({
        prompt: l10n.t("Git repository URL to clone into your repos folder"),
        placeHolder: "git@github.com:owner/repo.git",
        validateInput: (value) => value.trim() ? undefined : l10n.t("Enter a git URL"),
    });
    if (!url) { return; }

    const name = repoNameFromUrl(url);
    if (!name) {
        window.showErrorMessage(l10n.t("Couldn't derive a repo name from that URL."));
        return;
    }
    const targetDir = path.join(REPOS_BASE, name);
    if (fs.existsSync(targetDir)) {
        window.showWarningMessage(l10n.t("\"{0}\" already exists in your repos folder.", name));
        return;
    }

    await window.withProgress(
        { location: ProgressLocation.Notification, title: l10n.t("Cloning {0}…", name), cancellable: false },
        async () => {
            try {
                fs.mkdirSync(REPOS_BASE, { recursive: true });
                await execAsync(`git clone ${JSON.stringify(url.trim())} ${JSON.stringify(targetDir)}`, { timeout: 600000 });
                await addToGitRepoList(targetDir);
                await commands.executeCommand("projectManager.refreshGitProjects");
                window.showInformationMessage(l10n.t("Added repo \"{0}\".", name));
            } catch (err) {
                window.showErrorMessage(l10n.t("Failed to clone {0}: {1}", name, (err as Error).message));
            }
        }
    );
}

/**
 * Remove a repo from the Git list (non-destructive): drops it from the curated
 * list so it no longer shows in the Git view. The folder on disk is left intact.
 */
async function removeGitRepo(node: ProjectNode) {
    const repoPath: string = node?.preview?.path ?? node?.command?.arguments?.[0];
    if (!repoPath) { return; }
    const name = node?.preview?.name ?? path.basename(repoPath);

    const confirm = await window.showWarningMessage(
        l10n.t("Remove \"{0}\" from the Git list? The folder stays on disk.", name),
        { modal: true },
        l10n.t("Remove")
    );
    if (!confirm) { return; }

    await removeFromGitRepoList(repoPath);
    await commands.executeCommand("projectManager.refreshGitProjects");
    window.showInformationMessage(l10n.t("Removed \"{0}\" from the Git list.", name));
}

export function registerGitRepoCommands() {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.addGitRepo", () => addGitRepo()),
        commands.registerCommand("_projectManager.removeGitRepo", (node: ProjectNode) => removeGitRepo(node)),
    );
}
