import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, l10n, ProgressLocation, QuickPickItem, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { InvestigationNode } from "../sidebar/nodes";
import { spawnDetachedClone } from "./cloneProject";
import { run } from "./gitUtils";
import { forgetTmuxAutoOpened } from "../utils/tmuxAutoOpen";
import { latestSessionId, encodeProjectDir, copySessionWithCwdRewrite } from "./forkProject";
import { listCanonicalRepos } from "./addGitRepo";
import { PROJECTS_BASE } from "../core/constants";

const INVESTIGATION_KIND = "investigation";

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

function slugify(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "investigation";
}

const ADJECTIVES = [
    "amber", "azure", "bold", "brave", "bright", "calm", "clever", "cool",
    "crisp", "curious", "dark", "deep", "eager", "early", "empty", "fair",
    "fast", "fierce", "fluent", "fond", "free", "fresh", "gentle", "glad",
    "grand", "green", "grey", "heavy", "hidden", "hollow", "honest", "keen",
    "large", "late", "light", "lively", "lone", "long", "lucky", "mellow",
    "muted", "narrow", "neat", "nimble", "noble", "odd", "open", "patient",
    "plain", "proud", "pure", "quick", "quiet", "rapid", "rare", "ready",
    "rich", "round", "royal", "rusty", "safe", "sharp", "shiny", "short",
    "shy", "silent", "simple", "sleek", "slim", "slow", "small", "smart",
    "soft", "solid", "stern", "still", "strong", "sturdy", "subtle", "swift",
    "tall", "tame", "thin", "tidy", "tiny", "tough", "warm", "wide", "wild",
    "wise", "witty", "wry", "young", "zealous", "zesty",
];
const NOUNS = [
    "badger", "bear", "beetle", "bird", "boar", "brook", "buck", "bug",
    "cave", "cedar", "cliff", "cloud", "coral", "crane", "creek", "crow",
    "dawn", "deer", "delta", "dune", "dust", "eagle", "echo", "fern",
    "field", "finch", "flame", "flint", "flood", "fog", "forest", "fox",
    "frog", "frost", "gale", "glen", "gloom", "grove", "hawk", "heath",
    "heron", "hill", "hive", "hollow", "hound", "iris", "island", "ivy",
    "jay", "kelp", "kite", "lake", "lark", "leaf", "ledge", "light",
    "lime", "lynx", "marsh", "mist", "moon", "moose", "moth", "mouse",
    "mule", "nest", "night", "oak", "otter", "owl", "path", "peak",
    "pine", "plain", "pond", "pool", "quail", "rain", "raven", "reed",
    "reef", "ridge", "river", "robin", "rock", "root", "rose", "rush",
    "sage", "sand", "seed", "shade", "shore", "shrew", "shrub", "sky",
    "slug", "smoke", "snail", "snake", "snow", "sparrow", "spider", "spring",
    "stag", "star", "stem", "stone", "stork", "storm", "stream", "swan",
    "swift", "thorn", "tide", "toad", "trail", "tree", "vale", "vine",
    "vole", "wasp", "wave", "weed", "wolf", "wren",
];

function generateInvestigationName(): string {
    const adj = ADJECTIVES[ Math.floor(Math.random() * ADJECTIVES.length) ];
    const noun = NOUNS[ Math.floor(Math.random() * NOUNS.length) ];
    return `${adj}-${noun}`;
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

// Create an empty scratch folder in ~/projects for an investigation, unique-suffixed
// so two same-named investigations don't collide.
function createScratchDir(name: string): string {
    let dirName = slugify(name);
    let cwd = path.join(PROJECTS_BASE, dirName);
    if (fs.existsSync(cwd)) {
        dirName = `${dirName}-${Date.now().toString(36)}`;
        cwd = path.join(PROJECTS_BASE, dirName);
    }
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
}

async function newInvestigation(projectStorage: ProjectStorage, providerManager: Providers) {
    const name = generateInvestigationName();
    const cwd = createScratchDir(name);
    projectStorage.push(name, cwd, INVESTIGATION_KIND);
    projectStorage.save();
    providerManager.refreshStorageTreeView();

    // Eagerly start a detached tmux session running Claude, so opening the
    // investigation attaches to an already-warmed session instead of a bash prompt.
    const sessionName = path.basename(cwd).replace(/\./g, "-");
    try {
        await run(
            `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(cwd)} bash -lic ${shellQuote("claude --dangerously-skip-permissions; exec bash -l")} 2>/dev/null || true`,
            cwd
        );
    } catch { /* tmux unavailable — opening will start it on demand */ }
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
    forgetTmuxAutoOpened(inv.rootPath);
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

    const repos = listCanonicalRepos();
    const picks: QuickPickItem[] = repos.map(rootPath => ({ label: path.basename(rootPath), description: rootPath }));
    if (picks.length === 0) {
        window.showWarningMessage(l10n.t("No Git repos available to promote into. Add one via the Git section first."));
        return;
    }
    const repoPick = await window.showQuickPick(picks, { placeHolder: l10n.t("Clone which repo for the promoted project?") });
    if (!repoPick) { return; }
    const sourcePath = repoPick.description as string;

    const sourceName = path.basename(sourcePath);
    const nameInput = await window.showInputBox({
        prompt: l10n.t("New project name (folder + branch)"),
        value: slugify(inv.name),
        validateInput: (value) => (!value || !value.trim()) ? l10n.t("Name is required") : undefined
    });
    if (!nameInput) { return; }
    const newName = nameInput.trim();

    const sessionId = latestSessionId(inv.rootPath);
    const targetDir = path.join(path.dirname(sourcePath), newName);
    const pendingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
    const sessionSrcDir = sessionId ? path.join(claudeProjectsDir, encodeProjectDir(inv.rootPath)) : undefined;
    const sessionDstDir = sessionId ? path.join(claudeProjectsDir, encodeProjectDir(targetDir)) : undefined;
    const invSessionName = path.basename(inv.rootPath).replace(/\./g, "-");

    // Remove the investigation entry immediately — the detached script handles
    // the folder cleanup. Worst case (clone fails), the folder remains on disk
    // but the entry is gone; user can re-add manually.
    try { await run(`tmux kill-session -t ${shellQuote("=" + invSessionName)} 2>/dev/null`, PROJECTS_BASE); } catch { /* */ }
    try { fs.rmSync(inv.rootPath, { recursive: true, force: true }); } catch { /* */ }
    projectStorage.pop(inv.name);
    projectStorage.save();
    forgetTmuxAutoOpened(inv.rootPath);
    providerManager.refreshStorageTreeView();

    spawnDetachedClone({
        sourcePath, targetDir, branchName: newName, pendingId,
        sessionId: sessionId ?? undefined,
        sessionSrcDir, sessionDstDir,
    });
    window.showInformationMessage(
        l10n.t("Promoting in the background — \"{0}\" will appear in Projects when done.", newName)
    );
}

/**
 * Fork (split) an investigation: spin up a NEW scratch investigation that carries
 * the source's Claude session (transcript copied + cwd-rewritten) and resume it,
 * leaving the source intact — so one line of investigation branches into two.
 */
async function forkInvestigation(arg: InvestigationNode | string, projectStorage: ProjectStorage, providerManager: Providers) {
    const inv = findInvestigation(arg, projectStorage);
    if (!inv) { return; }

    const nameInput = await window.showInputBox({
        prompt: l10n.t("New investigation name"),
        value: `${inv.name} (fork)`,
        validateInput: (value) => (!value || !value.trim()) ? l10n.t("Name is required") : undefined
    });
    if (!nameInput) { return; }
    const newName = nameInput.trim();

    const sessionId = latestSessionId(inv.rootPath);

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Forking investigation..."),
        cancellable: false
    }, async (progress) => {
        try {
            const targetDir = createScratchDir(newName);

            let resumeId: string | undefined;
            if (sessionId) {
                progress.report({ message: l10n.t("Carrying Claude session...") });
                const copied = await copySessionWithCwdRewrite(inv.rootPath, targetDir, sessionId);
                if (copied) { resumeId = sessionId; }
            }

            projectStorage.push(newName, targetDir, INVESTIGATION_KIND);
            projectStorage.save();
            providerManager.refreshStorageTreeView();

            const sessionName = path.basename(targetDir).replace(/\./g, "-");
            const claudeCmd = resumeId
                ? `claude --resume ${resumeId} --dangerously-skip-permissions; exec bash -l`
                : `claude --dangerously-skip-permissions; exec bash -l`;
            await run(
                `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(targetDir)} bash -lic ${shellQuote(claudeCmd)} 2>/dev/null || true`,
                targetDir
            );

            const choice = await window.showInformationMessage(
                l10n.t("Forked \"{0}\" to \"{1}\".", inv.name, newName),
                l10n.t("Open Investigation")
            );
            if (choice) {
                commands.executeCommand("_projectManager.open", targetDir, newName);
            }
        } catch (error) {
            window.showErrorMessage(l10n.t("Failed to fork investigation: {0}", error.message));
        }
    });
}

export function registerInvestigations(projectStorage: ProjectStorage, providerManager: Providers) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.newInvestigation", () => newInvestigation(projectStorage, providerManager)),
        commands.registerCommand("_projectManager.openInvestigationTmux", (arg) => openInvestigationTmux(arg, projectStorage)),
        commands.registerCommand("_projectManager.forkInvestigation", (arg) => forkInvestigation(arg, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.promoteInvestigation", (arg) => promoteInvestigation(arg, projectStorage, providerManager)),
        commands.registerCommand("_projectManager.deleteInvestigation", (arg) => deleteInvestigation(arg, projectStorage, providerManager)),
    );
}
