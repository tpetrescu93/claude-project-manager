/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { commands, l10n, window, workspace } from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { ProjectNode, ArchivedProjectNode } from "../sidebar/nodes";

const execAsync = promisify(exec);

function sessionNameFor(rootPath: string): string {
    return path.basename(rootPath).replace(/\./g, "-");
}

function isProjectOpenInCurrentWindow(projectPath: string): boolean {
    const folders = workspace.workspaceFolders || [];
    return folders.some(f => f.uri.fsPath === projectPath);
}

async function killTmuxSession(sessionName: string): Promise<boolean> {
    try {
        await execAsync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
        return true;
    } catch {
        // Session doesn't exist — that's fine
        return false;
    }
}

async function archiveProject(node: ProjectNode, projectStorage: ProjectStorage, providerManager: Providers) {
    const projectName = node.preview.name;
    const rootPath = node.preview.path;

    // Kill tmux session if it exists
    const session = sessionNameFor(rootPath);
    await killTmuxSession(session);

    // Disable the project
    projectStorage.toggleEnabled(projectName);
    projectStorage.save();
    providerManager.refreshStorageTreeView();

    window.showInformationMessage(l10n.t("Project \"{0}\" archived.", projectName));
}

async function restoreProject(node: ArchivedProjectNode, projectStorage: ProjectStorage, providerManager: Providers) {
    const projectName = node.label as string;

    projectStorage.toggleEnabled(projectName);
    projectStorage.save();
    providerManager.refreshStorageTreeView();

    window.showInformationMessage(l10n.t("Project \"{0}\" restored.", projectName));
}

async function deleteArchivedProject(node: ArchivedProjectNode, projectStorage: ProjectStorage, providerManager: Providers) {
    const projectName = node.label as string;
    const projectPath = node.preview.path;

    if (isProjectOpenInCurrentWindow(projectPath)) {
        window.showWarningMessage(l10n.t("Cannot delete \"{0}\" — it is open in this window. Close it first.", projectName));
        return;
    }

    const confirm = await window.showWarningMessage(
        l10n.t("Delete \"{0}\" and remove its folder from disk?", projectName),
        { modal: true },
        l10n.t("Delete")
    );

    if (!confirm) { return; }

    // Remove PM entry
    projectStorage.pop(projectName);
    projectStorage.save();

    // Delete folder from disk
    try {
        await execAsync(`rm -rf "${projectPath}"`);
    } catch {
        // Folder may already be gone
    }

    // Kill tmux session if still around
    await killTmuxSession(sessionNameFor(projectPath));

    providerManager.refreshStorageTreeView();
    window.showInformationMessage(l10n.t("Project \"{0}\" deleted.", projectName));
}

async function killArchivedTmux(node: ArchivedProjectNode) {
    const name = node.label as string;
    const killed = await killTmuxSession(sessionNameFor(node.preview.path));
    window.showInformationMessage(killed
        ? l10n.t("Tmux session for \"{0}\" killed.", name)
        : l10n.t("No tmux session for \"{0}\" was running.", name));
}

async function killAllArchivedTmux(projectStorage: ProjectStorage) {
    const disabled = projectStorage.disabled() || [];
    if (disabled.length === 0) { return; }

    let killedCount = 0;
    for (const project of disabled) {
        if (await killTmuxSession(sessionNameFor(project.rootPath))) { killedCount++; }
    }

    window.showInformationMessage(killedCount === 0
        ? l10n.t("No tmux sessions were running for archived projects.")
        : l10n.t("Killed {0} tmux session(s) for archived projects.", killedCount));
}

async function deleteAllArchived(projectStorage: ProjectStorage, providerManager: Providers) {
    const disabled = projectStorage.disabled() || [];
    if (disabled.length === 0) { return; }

    const openProject = disabled.find(p => isProjectOpenInCurrentWindow(p.rootPath));
    if (openProject) {
        window.showWarningMessage(l10n.t("Cannot delete all — \"{0}\" is open in this window. Close it first.", openProject.name));
        return;
    }

    const confirm = await window.showWarningMessage(
        l10n.t("Delete all {0} archived projects and their folders from disk?", disabled.length),
        { modal: true },
        l10n.t("Delete All")
    );

    if (!confirm) { return; }

    for (const project of disabled) {
        try {
            await execAsync(`rm -rf "${project.rootPath}"`);
        } catch {
            // Folder may already be gone
        }
        await killTmuxSession(sessionNameFor(project.rootPath));
        projectStorage.pop(project.name);
    }

    projectStorage.save();
    providerManager.refreshStorageTreeView();
    window.showInformationMessage(l10n.t("All archived projects deleted."));
}

export function registerArchiveCommands(projectStorage: ProjectStorage, providerManager: Providers) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.archiveProject",
            (node: ProjectNode) => archiveProject(node, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.restoreProject",
            (node: ArchivedProjectNode) => restoreProject(node, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.deleteArchivedProject",
            (node: ArchivedProjectNode) => deleteArchivedProject(node, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.deleteAllArchived",
            () => deleteAllArchived(projectStorage, providerManager)),
        commands.registerCommand("_projectManager.killArchivedTmux",
            (node: ArchivedProjectNode) => killArchivedTmux(node)),
        commands.registerCommand("_projectManager.killAllArchivedTmux",
            () => killAllArchivedTmux(projectStorage)),
    );
}
