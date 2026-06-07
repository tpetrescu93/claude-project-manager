import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { env, EventEmitter, Uri, window as vscodeWindow, workspace } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { Providers } from "../sidebar/providers";
import { reactToMergedPr } from "./reactToMergedPr";
import { bulkFetchPrStatuses, BulkFetchInput, parseRepoFromRemote } from "./githubBulkFetch";
import { getSlackPost } from "./slackPostStore";
import { drainPendingProjects, drainPendingErrors, pendingDir } from "./pendingProjectStore";

const execAsync = promisify(exec);

const STATUS_RE = /^[●✗…✓○] | [●✗…✓○]$| \[(🔁|✅|PR|merged)\]$|^\[(🔁|✅|PR|merged)\] /;
const THINKING_RE = / \*$/;
const MERGED_WINDOW_DAYS = 30;
const GIT_INTERVAL_MS = 6_000;
const CLAUDE_INTERVAL_MS = 2_000;

export type PrStatus = "open_passing" | "open_posted" | "open_approved" | "changes_requested" | "open_failing" | "open_pending" | "open_conflicting" | "merged" | "no_pr" | null;

export interface PrMeta {
    number: number;
    title: string;
    author: string;               // GitHub login of the PR author
    updatedAt: string;            // ISO timestamp of the PR's last update
    additions: number;
    deletions: number;
    changedFiles: number;
    unresolvedThreads: number;
    totalThreads: number;
    mergeable: string;            // MERGEABLE | CONFLICTING | UNKNOWN
    reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
}

const statusCache = new Map<string, PrStatus>();
const prUrlCache = new Map<string, string>();
const prMetaCache = new Map<string, PrMeta>();
const claudeThinkingCache = new Map<string, boolean>();
const claudeNeedsInputCache = new Map<string, boolean>();
const lastPaneContentCache = new Map<string, string>();

/**
 * Returns the pane content above the live input prompt `❯ `. Strips the
 * input line itself plus everything below it (separator, wall-clock line,
 * status bar, footer) so that:
 *   - typing in the prompt doesn't count as "Claude thinking"
 *   - the clock ticking every minute doesn't trigger a false positive
 */
function paneContentAboveInput(out: string): string {
    const lines = out.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[ i ].trimStart().startsWith("❯")) {
            return lines.slice(0, i).join("\n");
        }
    }
    return out;
}
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
const PR_META_CACHE_KEY = "projectStatuses.prMetaCache";

function loadCachesFromGlobalState(): void {
    const status = Container.context.globalState.get<Record<string, PrStatus>>(STATUS_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(status)) {
        statusCache.set(rootPath, value);
    }
    const urls = Container.context.globalState.get<Record<string, string>>(PR_URL_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(urls)) {
        prUrlCache.set(rootPath, value);
    }
    const meta = Container.context.globalState.get<Record<string, PrMeta>>(PR_META_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(meta)) {
        prMetaCache.set(rootPath, value);
    }
}

function persistCachesToGlobalState(): void {
    const status: Record<string, PrStatus> = {};
    for (const [ k, v ] of statusCache) { status[ k ] = v; }
    const urls: Record<string, string> = {};
    for (const [ k, v ] of prUrlCache) { urls[ k ] = v; }
    const meta: Record<string, PrMeta> = {};
    for (const [ k, v ] of prMetaCache) { meta[ k ] = v; }
    Container.context.globalState.update(STATUS_CACHE_KEY, status);
    Container.context.globalState.update(PR_URL_CACHE_KEY, urls);
    Container.context.globalState.update(PR_META_CACHE_KEY, meta);
}

export function getPrStatusForPath(rootPath: string): PrStatus {
    return statusCache.get(rootPath) ?? null;
}

/**
 * Update the status cache to reflect the current Slack post store state and
 * immediately refresh the project's icon — use after setSlackPost/deleteSlackPost
 * so the overlay flips without waiting for the next 6s poll.
 */
export function refreshProjectStatusIcon(rootPath: string, providerManager: import("../sidebar/providers").Providers): void {
    const current = statusCache.get(rootPath) ?? null;
    const hasSlack = !!(getSlackPost(rootPath));
    let updated: PrStatus = current;
    if (hasSlack && current === "open_passing") { updated = "open_posted"; }
    if (!hasSlack && current === "open_posted") { updated = "open_passing"; }
    if (updated !== current) {
        statusCache.set(rootPath, updated);
        persistCachesToGlobalState();
    }
    statusChangeEmitter.fire();
    refreshAfterStatusChange(providerManager, rootPath);
}

export function getPrUrlForPath(rootPath: string): string | undefined {
    return prUrlCache.get(rootPath);
}

export function getPrMetaForPath(rootPath: string): PrMeta | undefined {
    return prMetaCache.get(rootPath);
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
            // `=name:` forces exact-match on the session (its active pane). Plain `-t name`
            // prefix-matches, so a project whose name prefixes another's would scrape the
            // wrong session; bare `=name` is rejected (capture-pane targets a pane, not a
            // session), so the trailing `:` (session's active window/pane) is required.
            `tmux capture-pane -t "=${sessionName}:" -p -S -20`,
            { timeout: 5000 }
        );
        const out = result.stdout;

        // Thinking = output above the input prompt changed since last poll.
        // When the spinner is active, the leading glyph cycles every ~100ms,
        // the elapsed-time counter ticks every second, and any content streaming
        // changes the buffer — all reliable signals of "Claude is doing work".
        // When idle, the content area is static (spinner gone) → no diff.
        const content = paneContentAboveInput(out);
        const prev = lastPaneContentCache.get(projectPath);
        lastPaneContentCache.set(projectPath, content);
        const thinking = prev !== undefined && prev !== content;

        // Picker footer detection. When a picker is active the selected option
        // is prefixed with `❯`, so paneContentAboveInput would strip the actual
        // picker footer (below the selection). Use the raw last 15 lines instead;
        // the picker footer always sits at the very bottom when active.
        // Match the stable ends of the footer ("Enter to select" … "Esc to cancel")
        // so it catches every picker variant — single-select uses "↑/↓ to navigate",
        // the AskUserQuestion multi-picker uses "Tab/Arrow keys to navigate", etc.
        // Single-line match (no newline in `.`) keeps it anchored to one footer line.
        const rawBottom = out.split("\n").slice(-15).join("\n");
        const needsInput = /Enter to select.*Esc to cancel/.test(rawBottom);

        return { thinking, needsInput };
    } catch {
        // No tmux session — drop any stored content so we don't compare across
        // a session restart.
        lastPaneContentCache.delete(projectPath);
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
    const projects = (projectStorage as any).projects as Array<{ name: string; rootPath: string; enabled?: boolean; kind?: string }>;
    if (!projects || projects.length === 0) { return; }

    // Resolve (branch, owner, repo) per project in parallel from local git, skipping
    // archived-already-merged rows (terminal state), default-branch/main checkouts, and
    // investigations (scratch dirs with no git repo).
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

function applyStatusUpdate(rootPath: string, result: { status: PrStatus; url?: string; meta?: PrMeta }, providerManager: Providers) {
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

async function updateClaudeStatuses(projectStorage: ProjectStorage, providerManager: Providers) {
    // Investigations are normal projects.json entries now, so they're already in
    // this list — no special-casing needed. Archived projects (enabled === false)
    // are skipped: their tmux session is killed on archive, and the archived tree
    // doesn't render Claude status anyway, so polling them is wasted subprocess
    // spawns that only add contention to the live sessions' captures.
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
    // Guard: skip entirely once all non-investigation projects have a repoName.
    // This turns the migration into a true one-shot — after the first successful
    // run it becomes a no-op with zero git spawns on activation.
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
        // Strip the "repoName-" prefix from the stored name so projects.json is
        // the single source of truth — no display-time string manipulation needed.
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
    // Restore PR status / URL caches from disk so icons render immediately on activation
    loadCachesFromGlobalState();
    providerManager.refreshStorageTreeView();

    // Clean up any leftover PR prefixes from the old cron in names on startup
    if (cleanLegacyPrefixes(projectStorage)) {
        projectStorage.save();
        providerManager.refreshStorageTreeView();
    }

    // Pick up any clone/fork/promote operations that completed while the ext
    // host was dead (workspace switch mid-run).
    reconcilePendingProjects(projectStorage, providerManager);

    // One-shot migration: backfill repoName for any projects that don't have it yet.
    // Runs in parallel, swallows errors (non-git / no remote = no repoName).
    migrateRepoNames(projectStorage, providerManager).catch(() => { /* swallow */ });

    const gitTimer = setInterval(() => {
        updateGitStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, GIT_INTERVAL_MS);

    const claudeTimer = setInterval(() => {
        updateClaudeStatuses(projectStorage, providerManager).catch(() => { /* swallow */ });
    }, CLAUDE_INTERVAL_MS);

    // Poll for pending projects every 5s as a fallback for platforms where
    // fs.watch is unreliable (Linux inotify limits, network drives, Windows).
    const pendingTimer = setInterval(() => {
        reconcilePendingProjects(projectStorage, providerManager);
    }, 5_000);

    // fs.watch gives instant feedback on macOS (FSEvents) and most Linux setups.
    // Errors/unavailability are swallowed — the interval is the safety net.
    let watcher: fs.FSWatcher | undefined;
    try {
        fs.mkdirSync(pendingDir(), { recursive: true });
        watcher = fs.watch(pendingDir(), () => {
            reconcilePendingProjects(projectStorage, providerManager);
        });
    } catch { /* fs.watch unavailable — interval covers it */ }

    // Run once on activation
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
