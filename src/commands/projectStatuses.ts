/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";

const execAsync = promisify(exec);

const STATUS_RE = /^[●✗…✓○] | [●✗…✓○]$| \[(🔁|✅|PR|merged)\]$|^\[(🔁|✅|PR|merged)\] /;
const THINKING_RE = / \*$/;
const MERGED_WINDOW_DAYS = 30;
const GIT_INTERVAL_MS = 60_000;
const CLAUDE_INTERVAL_MS = 2_000;

export type PrStatus = "open_passing" | "open_failing" | "open_pending" | "merged" | "no_pr" | null;

const statusCache = new Map<string, PrStatus>();
const statusChangeEmitter = new EventEmitter<void>();
export const onStatusChange = statusChangeEmitter.event;

export function getPrStatusForPath(rootPath: string): PrStatus {
    return statusCache.get(rootPath) ?? null;
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

async function getPrStatus(projectPath: string): Promise<PrStatus> {
    try {
        const branch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: projectPath, timeout: 5000 })).stdout.trim();
        if (branch === "HEAD" || branch === "master" || branch === "main" || branch === "develop") {
            return null;
        }

        // Open PR with CI status
        const openResult = await execAsync(
            `gh pr list --state open --head "${branch}" --limit 1 --json number,statusCheckRollup`,
            { cwd: projectPath, timeout: 10_000 }
        );
        const openData = JSON.parse(openResult.stdout);
        if (openData.length > 0) {
            const checks = openData[ 0 ].statusCheckRollup || [];
            if (checks.length === 0) { return "open_pending"; }
            const statuses = new Set(checks.map((c: any) => c.status || ""));
            const conclusions = new Set(checks.map((c: any) => c.conclusion || ""));
            if (Array.from(statuses).some(s => s !== "COMPLETED")) { return "open_pending"; }
            if (conclusions.has("FAILURE") || conclusions.has("ERROR") || conclusions.has("TIMED_OUT")) { return "open_failing"; }
            return "open_passing";
        }

        // Recently merged
        const mergedResult = await execAsync(
            `gh pr list --state merged --head "${branch}" --limit 1 --json mergedAt`,
            { cwd: projectPath, timeout: 10_000 }
        );
        const mergedData = JSON.parse(mergedResult.stdout);
        if (mergedData.length > 0) {
            const mergedAt = new Date(mergedData[ 0 ].mergedAt);
            const ageDays = (Date.now() - mergedAt.getTime()) / (1000 * 60 * 60 * 24);
            if (ageDays < MERGED_WINDOW_DAYS) { return "merged"; }
        }

        return "no_pr";
    } catch {
        return null;
    }
}

async function isClaudeThinking(projectPath: string): Promise<boolean> {
    try {
        const sessionName = path.basename(projectPath).replace(/\./g, "-");
        const result = await execAsync(
            `tmux capture-pane -t "${sessionName}" -p -S -50`,
            { timeout: 5000 }
        );
        const content = result.stdout.toLowerCase();
        return content.includes("thought for") || content.includes("thinking");
    } catch {
        return false;
    }
}

function cleanLegacyPrefixes(projectStorage: ProjectStorage): boolean {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string }>;
    if (!projects) { return false; }

    let changed = false;
    for (const project of projects) {
        const cleaned = stripPrPrefix(project.name);
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

    const statuses = await Promise.all(
        projects.map(p => getPrStatus(p.rootPath).catch(() => null))
    );

    let changed = false;
    for (let i = 0; i < projects.length; i++) {
        const project = projects[ i ];
        const newStatus = statuses[ i ];
        const oldStatus = statusCache.get(project.rootPath) ?? null;
        if (newStatus !== oldStatus) {
            statusCache.set(project.rootPath, newStatus);
            changed = true;
        }
    }

    if (changed) {
        statusChangeEmitter.fire();
        providerManager.refreshStorageTreeView();
    }
}

async function updateClaudeStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string }>;
    if (!projects || projects.length === 0) { return; }

    const thinking = await Promise.all(
        projects.map(p => isClaudeThinking(p.rootPath).catch(() => false))
    );

    let changed = false;
    for (let i = 0; i < projects.length; i++) {
        const project = projects[ i ];
        const isThinking = thinking[ i ];
        const hasMarker = THINKING_RE.test(project.name);

        if (isThinking && !hasMarker) {
            project.name = project.name + " *";
            changed = true;
        } else if (!isThinking && hasMarker) {
            project.name = project.name.replace(THINKING_RE, "");
            changed = true;
        }
    }

    if (changed) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }
}

export function registerProjectStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
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
