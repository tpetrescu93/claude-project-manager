/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, l10n, ProgressLocation, QuickPickItem, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { InvestigationNode } from "../sidebar/nodes";
import { run, performClone } from "./cloneProject";
import { copySessionWithCwdRewrite, latestSessionId } from "./forkProject";
import { getPinnedGitRepos } from "./gitPinning";

const INVESTIGATION_KIND = "investigation";
// Investigations are normal projects.json entries (kind: investigation) whose
// folder lives in ~/projects, alongside every other project.
const PROJECTS_BASE = path.join(os.homedir(), "projects");

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

function slugify(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "investigation";
}

function projects(projectStorage: ProjectStorage): Array<{ name: string; rootPath: string; kind?: string }> {
    return (projectStorage as any).projects;
}

function findInvestigation(arg: InvestigationNode | string | undefined, projectStorage: ProjectStorage):
    { name: string; rootPath: string } | undefined {
    const rootPath = typeof arg === "string" ? arg : arg?.rootPath;
    if (!rootPath) { return undefined; }
    return projects(projectStorage).find(p => p.rootPath === rootPath && p.kind === INVESTIGATION_KIND);
}

async function newInvestigation(projectStorage: ProjectStorage, providerManager: Providers) {
    const name = await window.showInputBox({
        prompt: l10n.t("Investigation name"),
        placeHolder: l10n.t("e.g. why is the repayment calc returning None")
    });
    if (!name || !name.trim()) { return; }

    // Folder in ~/projects, unique-suffixed so two same-named investigations don't collide.
    let dirName = slugify(name);
    let cwd = path.join(PROJECTS_BASE, dirName);
    if (fs.existsSync(cwd)) {
        dirName = `${dirName}-${Date.now().toString(36)}`;
        cwd = path.join(PROJECTS_BASE, dirName);
    }
    fs.mkdirSync(cwd, { recursive: true });

    projectStorage.push(name.trim(), cwd, INVESTIGATION_KIND);
    projectStorage.save();
    providerManager.refreshStorageTreeView();
    // Deliberately NOT starting a tmux/claude session here — creation just
    // registers the investigation. Start it via "Open Tmux Session".
    window.showInformationMessage(l10n.t("Investigation \"{0}\" created.", name.trim()));
}

async function openInvestigationTmux(arg: InvestigationNode | string, projectStorage: ProjectStorage) {
    const inv = findInvestigation(arg, projectStorage);
    if (!inv) { return; }
    commands.executeCommand("_projectManager.openTmuxSession", { preview: { path: inv.rootPath, name: inv.name } });
}

async function deleteInvestigation(arg: InvestigationNode | string, projectStorage: ProjectStorage, providerManager: Providers) {
    const inv = findInvestigation(arg, projectStorage);
    if (!inv) { return; }

    const confirm = await window.showWarningMessage(
        l10n.t("Delete investigation \"{0}\" and its folder?", inv.name),
        { modal: true },
        l10n.t("Delete")
    );
    if (!confirm) { return; }

    const sessionName = path.basename(inv.rootPath).replace(/\./g, "-");
    try { await run(`tmux kill-session -t ${shellQuote("=" + sessionName)} 2>/dev/null`, PROJECTS_BASE); } catch { /* no session */ }
    try { fs.rmSync(inv.rootPath, { recursive: true, force: true }); } catch { /* already gone */ }
    projectStorage.pop(inv.name);
    projectStorage.save();
    providerManager.refreshStorageTreeView();
    window.showInformationMessage(l10n.t("Investigation \"{0}\" deleted.", inv.name));
}

/**
 * Promote a scratch investigation into a real git project: clone a pinned repo,
 * carry the investigation's Claude session into the new project (cwd-rewritten),
 * resume it, and remove the scratch investigation.
 */
async function promoteInvestigation(arg: InvestigationNode | string, projectStorage: ProjectStorage, providerManager: Providers) {
    const inv = findInvestigation(arg, projectStorage);
    if (!inv) { return; }

    const pinned = [ ...getPinnedGitRepos() ].sort();
    const picks: QuickPickItem[] = pinned.map(rootPath => ({ label: path.basename(rootPath), description: rootPath }));
    if (picks.length === 0) {
        window.showWarningMessage(l10n.t("No pinned Git repos available to promote into. Pin a repo in the Git section first."));
        return;
    }
    const repoPick = await window.showQuickPick(picks, { placeHolder: l10n.t("Clone which repo for the promoted project?") });
    if (!repoPick) { return; }
    const sourcePath = repoPick.description as string;

    const sourceName = path.basename(sourcePath);
    const nameInput = await window.showInputBox({
        prompt: l10n.t("New project name (folder + branch)"),
        value: `${sourceName}-${slugify(inv.name)}`,
        validateInput: (value) => (!value || !value.trim()) ? l10n.t("Name is required") : undefined
    });
    if (!nameInput) { return; }
    const newName = nameInput.trim();

    const sessionId = latestSessionId(inv.rootPath);

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Promoting investigation to project..."),
        cancellable: false
    }, async (progress) => {
        try {
            const targetDir = await performClone(sourcePath, newName, projectStorage, progress, newName);

            let resumeId: string | undefined;
            if (sessionId) {
                progress.report({ message: l10n.t("Carrying Claude session...") });
                const copied = await copySessionWithCwdRewrite(inv.rootPath, targetDir, sessionId);
                if (copied) { resumeId = sessionId; }
            }

            const sessionName = path.basename(targetDir).replace(/\./g, "-");
            const claudeCmd = resumeId
                ? `claude --resume ${resumeId} --dangerously-skip-permissions`
                : `claude --dangerously-skip-permissions`;
            await run(
                `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(targetDir)} bash -lic ${shellQuote(claudeCmd)} 2>/dev/null || true`,
                targetDir
            );

            // Remove the scratch investigation now that it's a real project.
            const invSession = path.basename(inv.rootPath).replace(/\./g, "-");
            try { await run(`tmux kill-session -t ${shellQuote("=" + invSession)} 2>/dev/null`, PROJECTS_BASE); } catch { /* */ }
            try { fs.rmSync(inv.rootPath, { recursive: true, force: true }); } catch { /* */ }
            projectStorage.pop(inv.name);
            projectStorage.save();
            providerManager.refreshStorageTreeView();

            const choice = await window.showInformationMessage(
                l10n.t("Promoted \"{0}\" to {1}.", inv.name, path.basename(targetDir)),
                l10n.t("Open Project")
            );
            if (choice) {
                commands.executeCommand("_projectManager.open", targetDir, path.basename(targetDir));
            }
        } catch (error) {
            window.showErrorMessage(l10n.t("Failed to promote investigation: {0}", error.message));
        }
    });
}

export function registerInvestigations(projectStorage: ProjectStorage, providerManager: Providers) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.newInvestigation", () => newInvestigation(projectStorage, providerManager)),
        commands.registerCommand("_projectManager.openInvestigationTmux", (arg) => openInvestigationTmux(arg, projectStorage)),
        commands.registerCommand("_projectManager.promoteInvestigation", (arg) => promoteInvestigation(arg, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.deleteInvestigation", (arg) => deleteInvestigation(arg, projectStorage, providerManager)),
    );
}
