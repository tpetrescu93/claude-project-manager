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

const execAsync = promisify(exec);

const STATUS_RE = /^[●✗…✓○] | [●✗…✓○]$| \[(🔁|✅|PR|merged)\]$|^\[(🔁|✅|PR|merged)\] /;
const THINKING_RE = / \*$/;
const MERGED_WINDOW_DAYS = 30;
const GIT_INTERVAL_MS = 60_000;
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

async function getPrStatus(projectPath: string): Promise<{ status: PrStatus; url?: string } | undefined> {
    let branch: string;
    try {
        branch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: projectPath, timeout: 5000 })).stdout.trim();
    } catch {
        // Not a git repo / git command failed — treat as confirmed "no status"
        return { status: null };
    }
    if (branch === "HEAD" || branch === "master" || branch === "main" || branch === "develop") {
        return { status: null };
    }
    try {

        // Open PR with CI status
        const openResult = await execAsync(
            `gh pr list --state open --head "${branch}" --limit 1 --json number,url,statusCheckRollup,mergeable,reviewDecision`,
            { cwd: projectPath, timeout: 10_000 }
        );
        const openData = JSON.parse(openResult.stdout);
        if (openData.length > 0) {
            const url = openData[ 0 ].url as string | undefined;
            const reviewDecision = openData[ 0 ].reviewDecision as string | undefined;
            // Conflicts block the merge regardless of CI; surface them first.
            // UNKNOWN means GitHub hasn't finished computing mergeability yet — ignore.
            if (openData[ 0 ].mergeable === "CONFLICTING") { return { status: "open_conflicting", url }; }
            // A human explicitly requested changes — the strongest "do something" signal,
            // shown ahead of CI state (the review block stands until re-approval).
            if (reviewDecision === "CHANGES_REQUESTED") { return { status: "changes_requested", url }; }
            const rawChecks = openData[ 0 ].statusCheckRollup || [];
            if (rawChecks.length === 0) { return { status: "open_pending", url }; }
            // gh returns every historical run of every check. Keep only the latest run
            // per check name so re-runs supersede earlier failures (matches GitHub UI behaviour).
            const latestByName = new Map<string, any>();
            for (const c of rawChecks) {
                const name = c.name || "";
                const ts = Date.parse(c.completedAt || c.startedAt || "") || 0;
                const existing = latestByName.get(name);
                const existingTs = existing ? (Date.parse(existing.completedAt || existing.startedAt || "") || 0) : -1;
                if (!existing || ts >= existingTs) { latestByName.set(name, c); }
            }
            const checks = Array.from(latestByName.values());
            const statuses = new Set(checks.map((c: any) => c.status || ""));
            const conclusions = new Set(checks.map((c: any) => c.conclusion || ""));
            if (Array.from(statuses).some(s => s !== "COMPLETED")) { return { status: "open_pending", url }; }
            if (conclusions.has("FAILURE") || conclusions.has("ERROR") || conclusions.has("TIMED_OUT")) { return { status: "open_failing", url }; }
            // CI is green — distinguish human-approved (ready to merge) from awaiting review.
            if (reviewDecision === "APPROVED") { return { status: "open_approved", url }; }
            return { status: "open_passing", url };
        }

        // Recently merged
        const mergedResult = await execAsync(
            `gh pr list --state merged --head "${branch}" --limit 1 --json mergedAt,url`,
            { cwd: projectPath, timeout: 10_000 }
        );
        const mergedData = JSON.parse(mergedResult.stdout);
        if (mergedData.length > 0) {
            const mergedAt = new Date(mergedData[ 0 ].mergedAt);
            const ageDays = (Date.now() - mergedAt.getTime()) / (1000 * 60 * 60 * 24);
            if (ageDays < MERGED_WINDOW_DAYS) { return { status: "merged", url: mergedData[ 0 ].url }; }
        }

        return { status: "no_pr" };
    } catch {
        // gh failed — return undefined so the caller keeps the previous cache entry
        return undefined;
    }
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
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string }>;
    if (!projects || projects.length === 0) { return; }

    // Fire each gh call independently and refresh only the affected project's tree node
    projects.forEach(p => {
        getPrStatus(p.rootPath).then(result => {
            if (!result) { return; } // gh failed — keep previous cache entry
            const newStatus = result.status;
            const newUrl = result.url;
            const oldStatus = statusCache.get(p.rootPath) ?? null;
            const oldUrl = prUrlCache.get(p.rootPath);
            let changed = false;
            if (newStatus !== oldStatus) {
                statusCache.set(p.rootPath, newStatus);
                changed = true;
                if (newStatus === "merged" && oldStatus !== "merged") {
                    reactToMergedPr(p.rootPath).catch(() => { /* logged inside */ });
                }
            }
            if (newUrl !== oldUrl) {
                if (newUrl) {
                    prUrlCache.set(p.rootPath, newUrl);
                } else {
                    prUrlCache.delete(p.rootPath);
                }
                changed = true;
            }
            if (changed) {
                persistCachesToGlobalState();
                statusChangeEmitter.fire();
                refreshAfterStatusChange(providerManager, p.rootPath);
            }
        }).catch(() => { /* swallow */ });
    });
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
