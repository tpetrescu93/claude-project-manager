/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { EventEmitter, workspace } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { reactToMergedPr } from "./reactToMergedPr";
import { bulkFetchPrStatuses, BulkFetchInput, parseRepoFromRemote } from "./githubBulkFetch";

const execAsync = promisify(exec);

const STATUS_RE = /^[●✗…✓○] | [●✗…✓○]$| \[(🔁|✅|PR|merged)\]$|^\[(🔁|✅|PR|merged)\] /;
const THINKING_RE = / \*$/;
const MERGED_WINDOW_DAYS = 30;
const GIT_INTERVAL_MS = 6_000;
const CLAUDE_INTERVAL_MS = 2_000;

export type PrStatus = "open_passing" | "open_approved" | "changes_requested" | "open_failing" | "open_pending" | "open_conflicting" | "merged" | "no_pr" | null;

const statusCache = new Map<string, PrStatus>();
const prUrlCache = new Map<string, string>();
const claudeThinkingCache = new Map<string, boolean>();
const claudeNeedsInputCache = new Map<string, boolean>();
const statusChangeEmitter = new EventEmitter<void>();
export const onStatusChange = statusChangeEmitter.event;

function refreshAfterStatusChange(providerManager: Providers, rootPath: string) {
    // When sort is by status, a single project's status flipping changes its
    // position in the list — a targeted node refresh isn't enough, the whole
    // tree needs to re-sort. Otherwise stick with the cheap per-node refresh.
    const sortBy = workspace.getConfiguration("projectManager").get<string>("sortList", "Name");
    if (sortBy === "Status") {
        providerManager.refreshStorageTreeView();
    } else {
        providerManager.refreshStorageProjectNode(rootPath);
    }
}

const STATUS_CACHE_KEY = "projectStatuses.statusCache";
const PR_URL_CACHE_KEY = "projectStatuses.prUrlCache";

function loadCachesFromGlobalState(): void {
    const status = Container.context.globalState.get<Record<string, PrStatus>>(STATUS_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(status)) {
        statusCache.set(rootPath, value);
    }
    const urls = Container.context.globalState.get<Record<string, string>>(PR_URL_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(urls)) {
        prUrlCache.set(rootPath, value);
    }
}

function persistCachesToGlobalState(): void {
    const status: Record<string, PrStatus> = {};
    for (const [ k, v ] of statusCache) { status[ k ] = v; }
    const urls: Record<string, string> = {};
    for (const [ k, v ] of prUrlCache) { urls[ k ] = v; }
    Container.context.globalState.update(STATUS_CACHE_KEY, status);
    Container.context.globalState.update(PR_URL_CACHE_KEY, urls);
}

export function getPrStatusForPath(rootPath: string): PrStatus {
    return statusCache.get(rootPath) ?? null;
}

export function getPrUrlForPath(rootPath: string): string | undefined {
    return prUrlCache.get(rootPath);
}

export function isClaudeThinkingForPath(rootPath: string): boolean {
    return claudeThinkingCache.get(rootPath) ?? false;
}

export function isClaudeWaitingForInputForPath(rootPath: string): boolean {
    return claudeNeedsInputCache.get(rootPath) ?? false;
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

async function captureClaudeState(projectPath: string): Promise<{ thinking: boolean; needsInput: boolean }> {
    try {
        const sessionName = path.basename(projectPath).replace(/\./g, "-");
        const result = await execAsync(
            `tmux capture-pane -t "${sessionName}" -p -S -20`,
            { timeout: 5000 }
        );
        const out = result.stdout;
        return {
            thinking: /\b(Computing|Forging|Ionizing|Manifesting|Thinking)…/.test(out),
            needsInput: out.includes("Enter to select · ↑/↓ to navigate · Esc to cancel"),
        };
    } catch {
        return { thinking: false, needsInput: false };
    }
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

async function updateGitStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string; enabled?: boolean }>;
    if (!projects || projects.length === 0) { return; }

    // Resolve (branch, owner, repo) per project in parallel from local git, skipping
    // archived-already-merged rows (terminal state) and default-branch/main checkouts.
    const eligible = projects.filter(p => !(p.enabled === false && statusCache.get(p.rootPath) === "merged"));
    const resolved = await Promise.all(eligible.map(p => resolveBulkInput(p.rootPath)));

    const inputs: BulkFetchInput[] = [];
    const skippedRootPaths: string[] = [];
    resolved.forEach((r, i) => {
        if (r) { inputs.push(r); }
        else { skippedRootPaths.push(eligible[ i ].rootPath); }
    });

    // Projects on main/master/develop or non-git become null status — collapse to that without an API call.
    for (const rootPath of skippedRootPaths) {
        applyStatusUpdate(rootPath, { status: null }, providerManager);
    }

    if (inputs.length === 0) { return; }
    const results = await bulkFetchPrStatuses(inputs);
    if (!results) { return; } // auth / network failed — preserve cache

    for (const [ rootPath, result ] of results) {
        applyStatusUpdate(rootPath, result, providerManager);
    }
}

function applyStatusUpdate(rootPath: string, result: { status: PrStatus; url?: string }, providerManager: Providers) {
    const newStatus = result.status;
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

async function updateClaudeStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string }>;
    if (!projects || projects.length === 0) { return; }

    projects.forEach(p => {
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

export function registerProjectStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    // Restore PR status / URL caches from disk so icons render immediately on activation
    loadCachesFromGlobalState();
    providerManager.refreshStorageTreeView();

    // Clean up any leftover PR prefixes from the old cron in names on startup
    if (cleanLegacyPrefixes(projectStorage)) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }

    const gitTimer = setInterval(() => {
        updateGitStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, GIT_INTERVAL_MS);

    const claudeTimer = setInterval(() => {
        updateClaudeStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, CLAUDE_INTERVAL_MS);

    // Run once on activation
    updateGitStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    updateClaudeStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });

    Container.context.subscriptions.push({
        dispose: () => {
            clearInterval(gitTimer);
            clearInterval(claudeTimer);
        }
    });
}
