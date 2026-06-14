/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { getGitRepoList, seedGitRepoListOnce } from "./gitRepoStore";
import { parseRepoFromRemote, bulkFetchDefaultBranches } from "./githubBulkFetch";

const execAsync = promisify(exec);

let channel: vscode.OutputChannel;
let syncing = false;

type SyncAction =
    | "up-to-date"      // already at the upstream default tip — no git network at all
    | "ff"              // fast-forwarded the checked-out default branch
    | "ff-ref"          // fast-forwarded the local default ref while on a feature branch
    | "skipped-dirty"   // on the default branch with uncommitted tracked changes
    | "skipped-diverged"// local default has diverged (non-ff)
    | "error";

interface SyncResult {
    name: string;
    action: SyncAction;
    detail?: string;
}

async function git(repo: string, args: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${JSON.stringify(repo)} ${args}`, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
}

/**
 * Fetch + fast-forward the default branch, non-destructively. On the default
 * branch + clean → `merge --ff-only`; on a feature branch → fast-forward the local
 * default ref without touching the working tree; dirty (tracked) or diverged →
 * leave it. Never switches branches, resets, or touches submodules.
 */
async function ffToDefault(repo: string, def: string): Promise<{ action: SyncAction; detail?: string }> {
    await git(repo, `fetch origin ${def} --quiet`);
    const current = await git(repo, "rev-parse --abbrev-ref HEAD");
    const behind = await git(repo, `rev-list --count ${def}..origin/${def}`).catch(() => "?");
    if (behind === "0") { return { action: "up-to-date" }; }

    if (current === def) {
        const dirty = (await git(repo, "status --porcelain --untracked-files=no")).length > 0;
        if (dirty) { return { action: "skipped-dirty" }; }
        try {
            await git(repo, `merge --ff-only --quiet origin/${def}`);
            return { action: "ff", detail: behind !== "?" ? `+${behind}` : undefined };
        } catch {
            return { action: "skipped-diverged" };
        }
    }

    try {
        await git(repo, `fetch origin ${def}:${def}`);
        return { action: "ff-ref", detail: behind !== "?" ? `+${behind}` : undefined };
    } catch {
        return { action: "skipped-diverged" };
    }
}

/**
 * Fast path: GraphQL already told us the upstream default branch + its tip OID.
 * Compare to the local default ref (instant) — if equal, the repo is current and
 * we touch the network zero times; only a mismatch triggers a real fetch + ff.
 */
async function syncViaHead(repo: string, def: string, remoteOid: string): Promise<SyncResult> {
    const name = path.basename(repo);
    try {
        const localOid = await git(repo, `rev-parse refs/heads/${def}`).catch(() => "");
        if (localOid && localOid === remoteOid) { return { name, action: "up-to-date" }; }
        return { name, ...(await ffToDefault(repo, def)) };
    } catch (err) {
        return { name, action: "error", detail: (err as Error).message.split("\n")[0] };
    }
}

/**
 * Git-only fallback for non-GitHub remotes (or when the GraphQL detection was
 * unavailable): resolve the default over the network, then ff.
 */
async function syncViaGit(repo: string): Promise<SyncResult> {
    const name = path.basename(repo);
    try {
        try { await git(repo, "remote set-head origin -a"); } catch { /* offline — use cached */ }
        let def: string;
        try {
            const head = await git(repo, "symbolic-ref --short refs/remotes/origin/HEAD");
            def = head.replace(/^origin\//, "");
        } catch {
            return { name, action: "error", detail: "couldn't resolve default branch (offline?)" };
        }
        if (!def) { return { name, action: "error", detail: "empty default branch" }; }
        return { name, ...(await ffToDefault(repo, def)) };
    } catch (err) {
        return { name, action: "error", detail: (err as Error).message.split("\n")[0] };
    }
}

async function syncAll(context: vscode.ExtensionContext, silent: boolean): Promise<void> {
    if (syncing) { return; }
    syncing = true;
    try {
        // The curated list is seeded lazily on the Git view's first refresh; seed
        // here too so the job works even if that view was never opened this session.
        await seedGitRepoListOnce();
        const repos = getGitRepoList();

        // Cheap batched detection: resolve each repo's GitHub owner/name, then one
        // GraphQL call returns every default branch name + tip OID at once.
        const ghRepos: { rootPath: string; owner: string; repo: string }[] = [];
        for (const repo of repos) {
            const url = await git(repo, "remote get-url origin").catch(() => "");
            const parsed = url ? parseRepoFromRemote(url) : undefined;
            if (parsed) { ghRepos.push({ rootPath: repo, owner: parsed.owner, repo: parsed.repo }); }
        }
        const heads = ghRepos.length ? await bulkFetchDefaultBranches(ghRepos) : new Map();

        const results: SyncResult[] = [];
        for (const repo of repos) {
            const head = heads?.get(repo);
            results.push(head
                ? await syncViaHead(repo, head.defaultBranch, head.oid)
                : await syncViaGit(repo));   // non-GitHub remote, or GraphQL unavailable
        }
        await context.globalState.update("gitRepoLastSync", Date.now());

        const ts = new Date().toISOString();
        const viaHead = heads ? heads.size : 0;
        channel.appendLine(`[${ts}] synced ${results.length} repo(s) — ${viaHead} via GraphQL detection`);
        for (const r of results) {
            channel.appendLine(`  ${r.name}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
        }

        if (!silent) {
            const updated = results.filter(r => r.action === "ff" || r.action === "ff-ref").length;
            const skipped = results.filter(r => r.action.startsWith("skipped")).length;
            const errored = results.filter(r => r.action === "error").length;
            vscode.window.showInformationMessage(
                `Repo sync: ${updated} updated, ${skipped} skipped, ${errored} error(s) (of ${results.length}).`
            );
        }
    } finally {
        syncing = false;
    }
}

/**
 * Background job that keeps the curated Git repos' default branches in sync with
 * upstream. Detection is a single batched GraphQL call (default branch name + tip
 * OID for all repos); only repos whose tip actually moved pay a git fetch + ff, so
 * the common "nothing changed" sweep does zero git network ops. Runs on an
 * in-extension `setInterval` (lives only while a window is open) plus a one-shot
 * kickoff on activation, gated by the `gitRepoLastSync` throttle so the frequent
 * ext-host restarts (every project switch) don't sweep more than once per interval.
 */
export function registerSyncGitRepos(context: vscode.ExtensionContext): void {
    channel = vscode.window.createOutputChannel("Project Manager: Repo Sync");
    context.subscriptions.push(channel);

    // Hidden manual trigger (command palette / debugging) — shows a summary toast.
    context.subscriptions.push(
        vscode.commands.registerCommand("_projectManager.syncGitRepos", async () => {
            channel.show(true);
            await syncAll(context, false);
        })
    );

    const cfg = () => vscode.workspace.getConfiguration("projectManager");
    const enabled = () => cfg().get<boolean>("git.autoSync.enabled", true);
    const periodMs = Math.max(1, cfg().get<number>("git.autoSync.intervalMinutes", 1)) * 60_000;

    if (!enabled()) { return; }

    const last = context.globalState.get<number>("gitRepoLastSync", 0);
    if (Date.now() - last >= periodMs) {
        void syncAll(context, true);
    }

    const timer = setInterval(() => {
        if (enabled()) { void syncAll(context, true); }
    }, periodMs);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
