import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { env, Uri, window as vscodeWindow, workspace } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { reactToMergedPr } from "./reactToMergedPr";
import { bulkFetchPrStatuses, BulkFetchInput, parseRepoFromRemote } from "./githubBulkFetch";
import { drainPendingProjects, drainPendingErrors, pendingDir } from "./pendingProjectStore";
import { getSlackPost } from "./slackPostStore";
import {
    statusCache, prUrlCache, prMetaCache,
    statusChangeEmitter,
    loadCachesFromGlobalState, persistCachesToGlobalState,
} from "./prStatusCache";
import { captureClaudeState, claudeThinkingCache, claudeNeedsInputCache } from "./claudeStatus";

// Re-export everything so existing import sites don't need changing
export type { PrStatus, PrMeta } from "./prStatusTypes";
export {
    onStatusChange,
    getPrStatusForPath, getPrUrlForPath, getPrMetaForPath,
} from "./prStatusCache";
export { isClaudeThinkingForPath, isClaudeWaitingForInputForPath } from "./claudeStatus";

const execAsync = promisify(exec);

const STATUS_RE = /^[●✗…✓○] | [●✗…✓○]$| \[(🔁|✅|PR|merged)\]$|^\[(🔁|✅|PR|merged)\] /;
const THINKING_RE = / \*$/;
const GIT_INTERVAL_MS = 6_000;
const CLAUDE_INTERVAL_MS = 2_000;

/**
 * Update the status cache to reflect the current Slack post store state and
 * immediately refresh the project's icon — use after setSlackPost/deleteSlackPost
 * so the overlay flips without waiting for the next 6s poll.
 */
export function refreshProjectStatusIcon(rootPath: string, providerManager: Providers): void {
    const current = statusCache.get(rootPath) ?? null;
    const hasSlack = !!(getSlackPost(rootPath));
    let updated: import("./prStatusTypes").PrStatus = current;
    if (hasSlack && current === "open_passing") { updated = "open_posted"; }
    if (!hasSlack && current === "open_posted") { updated = "open_passing"; }
    if (updated !== current) {
        statusCache.set(rootPath, updated);
        persistCachesToGlobalState();
    }
    statusChangeEmitter.fire();
    refreshAfterStatusChange(providerManager, rootPath);
}

function refreshAfterStatusChange(providerManager: Providers, rootPath: string) {
    const sortBy = workspace.getConfiguration("projectManager").get<string>("sortList", "Name");
    if (sortBy === "Status") {
        providerManager.refreshStorageTreeView();
    } else {
        providerManager.refreshStorageProjectNode(rootPath);
    }
}

function stripPrPrefix(name: string): string {
    let base = name;
    while (true) {
        const stripped = base.replace(STATUS_RE, "");
        if (stripped === base) { break; }
        base = stripped;
    }
    return base;
}

async function resolveBulkInput(rootPath: string): Promise<BulkFetchInput | null> {
    let branch: string;
    try {
        branch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: rootPath, timeout: 5000 })).stdout.trim();
    } catch {
        return null;
    }
    if (!branch || branch === "HEAD" || branch === "master" || branch === "main" || branch === "develop") {
        return null;
    }
    let remote: string;
    try {
        remote = (await execAsync("git remote get-url origin", { cwd: rootPath, timeout: 5000 })).stdout.trim();
    } catch {
        return null;
    }
    const parsed = parseRepoFromRemote(remote);
    if (!parsed) { return null; }
    return { rootPath, branch, owner: parsed.owner, repo: parsed.repo };
}

function cleanLegacyPrefixes(projectStorage: ProjectStorage): boolean {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string }>;
    if (!projects) { return false; }
    let changed = false;
    for (const project of projects) {
        let cleaned = stripPrPrefix(project.name);
        cleaned = cleaned.replace(THINKING_RE, "");
        if (cleaned !== project.name) {
            project.name = cleaned;
            changed = true;
        }
    }
    return changed;
}

function applyStatusUpdate(
    rootPath: string,
    result: { status: import("./prStatusTypes").PrStatus; url?: string; meta?: import("./prStatusTypes").PrMeta },
    providerManager: Providers
) {
    // PR metadata (for the hover tooltip) — store when an open PR was found.
    // Never delete: title/author remain valid after merge and are needed for
    // Jira transition on archive. Only cleared when the project is deleted.
    if (result.meta) {
        prMetaCache.set(rootPath, result.meta);
    }
    // "Posted to Slack" overlay: once a PR has been posted (a permalink is stored),
    // show open_posted instead of the plain green "passing, awaiting review" state.
    // Leaves actionable states (conflicting/changes_requested/failing/pending) and
    // approved (ready to merge) intact — those matter more than "announced".
    let newStatus = result.status;
    if (newStatus === "open_passing" && getSlackPost(rootPath)) {
        newStatus = "open_posted";
    }
    const newUrl = result.url;
    const oldStatus = statusCache.get(rootPath) ?? null;
    const oldUrl = prUrlCache.get(rootPath);
    let changed = false;
    if (newStatus !== oldStatus) {
        statusCache.set(rootPath, newStatus);
        changed = true;
        if (newStatus === "merged" && oldStatus !== "merged") {
            reactToMergedPr(rootPath).catch(() => { /* logged inside */ });
        }
    }
    if (newUrl !== oldUrl) {
        if (newUrl) {
            prUrlCache.set(rootPath, newUrl);
        } else {
            prUrlCache.delete(rootPath);
        }
        changed = true;
    }
    if (changed) {
        persistCachesToGlobalState();
        statusChangeEmitter.fire();
        refreshAfterStatusChange(providerManager, rootPath);
    }
}

async function updateGitStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string; enabled?: boolean; kind?: string }>;
    if (!projects || projects.length === 0) { return; }

    const eligible = projects.filter(p =>
        p.kind !== "investigation"
        && !(p.enabled === false && statusCache.get(p.rootPath) === "merged"));
    const resolved = await Promise.all(eligible.map(p => resolveBulkInput(p.rootPath)));

    const inputs: BulkFetchInput[] = [];
    const skippedRootPaths: string[] = [];
    resolved.forEach((r, i) => {
        if (r) { inputs.push(r); }
        else { skippedRootPaths.push(eligible[ i ].rootPath); }
    });

    for (const rootPath of skippedRootPaths) {
        applyStatusUpdate(rootPath, { status: null }, providerManager);
    }

    if (inputs.length === 0) { return; }
    const results = await bulkFetchPrStatuses(inputs);
    if (!results) { return; }

    for (const [ rootPath, result ] of results) {
        applyStatusUpdate(rootPath, result, providerManager);
    }
}

async function updateClaudeStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string; enabled?: boolean }> | undefined;
    const active = projects?.filter(p => p.enabled !== false);
    if (!active || active.length === 0) { return; }

    active.forEach(p => {
        captureClaudeState(p.rootPath).then(state => {
            const oldThinking = claudeThinkingCache.get(p.rootPath) ?? false;
            const oldNeedsInput = claudeNeedsInputCache.get(p.rootPath) ?? false;
            let changed = false;
            if (state.thinking !== oldThinking) {
                claudeThinkingCache.set(p.rootPath, state.thinking);
                changed = true;
            }
            if (state.needsInput !== oldNeedsInput) {
                claudeNeedsInputCache.set(p.rootPath, state.needsInput);
                changed = true;
            }
            if (changed) {
                statusChangeEmitter.fire();
                refreshAfterStatusChange(providerManager, p.rootPath);
            }
        }).catch(() => { /* swallow */ });
    });
}

async function migrateRepoNames(projectStorage: ProjectStorage, providerManager: Providers): Promise<void> {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string; kind?: string; repoName?: string }>;
    const needsMigration = projects.filter(p => p.kind !== "investigation" && !p.repoName);
    if (needsMigration.length === 0) { return; }

    const results = await Promise.all(needsMigration.map(async p => {
        try {
            const remote = (await execAsync("git remote get-url origin", { cwd: p.rootPath, timeout: 4000 })).stdout.trim();
            const parsed = parseRepoFromRemote(remote);
            return parsed ? { rootPath: p.rootPath, repoName: parsed.repo } : null;
        } catch { return null; }
    }));

    let changed = false;
    for (const r of results) {
        if (!r) { continue; }
        const p = projects.find(p => p.rootPath === r.rootPath);
        if (!p) { continue; }
        p.repoName = r.repoName;
        const prefix = r.repoName + "-";
        if (p.name.startsWith(prefix)) { p.name = p.name.slice(prefix.length); }
        changed = true;
    }
    if (changed) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }
}

function reconcilePendingProjects(projectStorage: ProjectStorage, providerManager: Providers): void {
    const errors = drainPendingErrors();
    for (const e of errors) {
        vscodeWindow.showErrorMessage(`Background operation failed: ${e.message}`, "Show Log")
            .then((choice) => { if (choice) { env.openExternal(Uri.file(e.logFile)); } });
    }

    const pending = drainPendingProjects();
    if (pending.length === 0) { return; }
    let changed = false;
    for (const p of pending) {
        if (!projectStorage.exists(p.name)) {
            projectStorage.push(p.name, p.rootPath, p.kind, p.repoName);
            changed = true;
        }
    }
    if (changed) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }
}

export function registerProjectStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    loadCachesFromGlobalState();
    providerManager.refreshStorageTreeView();

    if (cleanLegacyPrefixes(projectStorage)) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }

    reconcilePendingProjects(projectStorage, providerManager);
    migrateRepoNames(projectStorage, providerManager).catch(() => { /* swallow */ });

    const gitTimer = setInterval(() => {
        updateGitStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, GIT_INTERVAL_MS);

    const claudeTimer = setInterval(() => {
        updateClaudeStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, CLAUDE_INTERVAL_MS);

    const pendingTimer = setInterval(() => {
        reconcilePendingProjects(projectStorage, providerManager);
    }, 5_000);

    let watcher: fs.FSWatcher | undefined;
    try {
        fs.mkdirSync(pendingDir(), { recursive: true });
        watcher = fs.watch(pendingDir(), () => {
            reconcilePendingProjects(projectStorage, providerManager);
        });
    } catch { /* fs.watch unavailable — interval covers it */ }

    updateGitStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    updateClaudeStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });

    Container.context.subscriptions.push({
        dispose: () => {
            clearInterval(gitTimer);
            clearInterval(claudeTimer);
            clearInterval(pendingTimer);
            watcher?.close();
        }
    });
}
