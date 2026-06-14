/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { getGitRepoList, seedGitRepoListOnce } from "./gitRepoStore";

const execAsync = promisify(exec);

let channel: vscode.OutputChannel;
let syncing = false;

type SyncAction =
    | "up-to-date"      // already at upstream default tip
    | "ff"              // fast-forwarded the checked-out default branch
    | "ff-ref"          // fast-forwarded the local default ref while on a feature branch
    | "skipped-dirty"   // on default branch with uncommitted changes — left untouched
    | "skipped-diverged"// local default has diverged (non-ff) — left untouched
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
 * Bring a single canonical repo's DEFAULT branch in sync with its upstream,
 * non-destructively. Never switches branches, never resets, never touches
 * submodules. Honours these cases:
 *   - on the default branch + clean   → `merge --ff-only`
 *   - on a feature branch             → ff the local default ref via refspec fetch
 *   - dirty, or diverged (non-ff)     → fetch only, leave the branch alone
 */
async function syncRepo(repo: string): Promise<SyncResult> {
    const name = path.basename(repo);
    try {
        // Resolve the real upstream default (main vs master vs develop). Best-effort
        // network call; if offline we fall back to a previously-cached origin/HEAD.
        try { await git(repo, "remote set-head origin -a"); } catch { /* offline — use cached */ }

        let def: string;
        try {
            const head = await git(repo, "symbolic-ref --short refs/remotes/origin/HEAD"); // e.g. "origin/main"
            def = head.replace(/^origin\//, "");
        } catch {
            return { name, action: "error", detail: "couldn't resolve default branch (offline?)" };
        }
        if (!def) { return { name, action: "error", detail: "empty default branch" }; }

        await git(repo, `fetch origin ${def} --quiet`);

        const current = await git(repo, "rev-parse --abbrev-ref HEAD");
        const behind = await git(repo, `rev-list --count ${def}..origin/${def}`).catch(() => "?");
        if (behind === "0") { return { name, action: "up-to-date" }; }

        if (current === def) {
            // Only tracked changes block the ff. Untracked files are ignored: a
            // ff-only merge can't clobber them (git aborts if an incoming path would
            // overwrite an untracked file), so a stray file shouldn't stall syncing.
            const dirty = (await git(repo, "status --porcelain --untracked-files=no")).length > 0;
            if (dirty) { return { name, action: "skipped-dirty" }; }
            try {
                await git(repo, `merge --ff-only --quiet origin/${def}`);
                return { name, action: "ff", detail: behind !== "?" ? `+${behind}` : undefined };
            } catch {
                return { name, action: "skipped-diverged" };
            }
        }

        // Default branch isn't checked out — fast-forward its local ref without
        // touching the working tree. A non-ff (diverged) update is rejected by git
        // and surfaces as skipped-diverged.
        try {
            await git(repo, `fetch origin ${def}:${def}`);
            return { name, action: "ff-ref", detail: behind !== "?" ? `+${behind}` : undefined };
        } catch {
            return { name, action: "skipped-diverged" };
        }
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
        const results: SyncResult[] = [];
        for (const repo of repos) {
            results.push(await syncRepo(repo));
        }
        await context.globalState.update("gitRepoLastSync", Date.now());

        const ts = new Date().toISOString();
        channel.appendLine(`[${ts}] synced ${results.length} repo(s)`);
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
 * upstream. Runs on an in-extension `setInterval` (so it lives only while a VS
 * Code window is open) plus a one-shot kickoff on activation, gated by the
 * `gitRepoLastSync` throttle so the frequent ext-host restarts (every project
 * switch reloads the window) don't trigger more than one sweep per interval.
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
    const periodMs = Math.max(1, cfg().get<number>("git.autoSync.intervalMinutes", 10)) * 60_000;

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
