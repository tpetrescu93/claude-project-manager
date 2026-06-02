/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { exec } from "child_process";
import { promisify } from "util";
import { MarkdownString } from "vscode";
import {
    getPrStatusForPath, getPrUrlForPath, getPrMetaForPath, PrStatus,
    isClaudeThinkingForPath, isClaudeWaitingForInputForPath
} from "./projectStatuses";
import { getSlackPost } from "./slackPostStore";

const execAsync = promisify(exec);

const JIRA_BASE = "https://wagestream.atlassian.net/browse/";

// GitHub-ish hues that read on both light and dark themes. Rendered via inline
// HTML spans (requires md.supportHtml + isTrusted).
const GREEN = "#3fb950";
const RED = "#f85149";
const AMBER = "#d29922";
const BLUE = "#58a6ff";
const PURPLE = "#a371f7";
function colored(text: string, hex: string): string {
    return `<span style="color:${hex};">${text}</span>`;
}

/**
 * Pull a Jira key (e.g. CRED-4585) from the PR title's bracketed prefix first,
 * then fall back to the branch name's leading `key-number` convention. Returns
 * the uppercased key, or undefined if neither yields one.
 */
function extractJiraKey(title: string | undefined, branch: string | undefined): string | undefined {
    if (title) {
        const m = title.match(/([A-Z][A-Z0-9]*-\d+)/);
        if (m) { return m[ 1 ].toUpperCase(); }
    }
    if (branch) {
        const m = branch.match(/^([A-Za-z][A-Za-z0-9]*-\d+)/);
        if (m) { return m[ 1 ].toUpperCase(); }
    }
    return undefined;
}

// resolveTreeItem fires on every hover; cache the built tooltip briefly so hover
// jitter (mouse passing across rows) doesn't re-run the git/tmux shell-outs.
const TTL_MS = 8_000;
const cache = new Map<string, { ts: number; md: MarkdownString }>();

async function git(rootPath: string, args: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync(`git ${args}`, { cwd: rootPath, timeout: 4000 });
        return stdout.trim();
    } catch {
        return undefined;
    }
}

function statusWords(status: PrStatus): string | undefined {
    switch (status) {
        case "open_pending": return `${colored("$(sync~spin)", AMBER)} CI pending`;
        case "open_passing": return `${colored("$(pass-filled)", GREEN)} CI passing · awaiting review`;
        case "open_posted": return `${colored("$(comment-discussion)", BLUE)} CI passing · posted to Slack`;
        case "open_approved": return `${colored("$(check-all)", GREEN)} Approved · ready to merge`;
        case "changes_requested": return `${colored("$(request-changes)", RED)} Changes requested`;
        case "open_failing": return `${colored("$(error)", RED)} CI failing`;
        case "open_conflicting": return `${colored("$(warning)", AMBER)} Merge conflicts`;
        case "merged": return `${colored("$(git-merge)", PURPLE)} Merged`;
        case "no_pr":
        case null:
        default: return undefined;
    }
}

function escapeMd(s: string): string {
    // Defang the markdown control chars that show up in PR titles / commit subjects.
    return s.replace(/([\\`*_{}\[\]()#+\-.!|])/g, "\\$1");
}

function fmtDuration(seconds: number): string {
    if (seconds < 60) { return `${Math.floor(seconds)}s`; }
    const m = Math.floor(seconds / 60);
    if (m < 60) { return `${m}m`; }
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h < 24) { return rem ? `${h}h ${rem}m` : `${h}h`; }
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

/**
 * Build the rich hover tooltip for a project / investigation row. Combines
 * in-memory caches (PR status/meta, Slack link, Claude state — all free) with
 * lazy git + tmux shell-outs computed on hover.
 */
export async function buildProjectTooltip(rootPath: string, label: string, isInvestigation: boolean): Promise<MarkdownString> {
    const hit = cache.get(rootPath);
    if (hit && Date.now() - hit.ts < TTL_MS) { return hit.md; }

    const status = getPrStatusForPath(rootPath);
    const prUrl = getPrUrlForPath(rootPath);
    const meta = getPrMetaForPath(rootPath);
    const slack = getSlackPost(rootPath);
    const needsInput = isClaudeWaitingForInputForPath(rootPath);
    const thinking = isClaudeThinkingForPath(rootPath);

    // --- lazy git (skipped for investigations — empty scratch dirs, no repo) ---
    let branch: string | undefined;
    let dirtyCount = 0;
    let unpushed: string | undefined;
    let localDiff: string | undefined;
    let sessionUptime: string | undefined;

    const tmuxName = rootPath.split("/").pop()!.replace(/\./g, "-");
    const tasks: Promise<void>[] = [];

    if (!isInvestigation) {
        // One status call yields branch, ahead-count (unpushed) and the dirty
        // count together — cheaper than three separate spawns.
        tasks.push((async () => {
            const out = await git(rootPath, "status --porcelain=v2 --branch");
            if (!out) { return; }
            const lines = out.split("\n");
            for (const l of lines) {
                if (l.startsWith("# branch.head ")) { branch = l.slice("# branch.head ".length).trim(); }
                else if (l.startsWith("# branch.ab ")) {
                    const m = l.match(/\+(\d+)/);
                    if (m && m[ 1 ] !== "0") { unpushed = m[ 1 ]; }
                }
            }
            dirtyCount = lines.filter(l => l && !l.startsWith("#")).length;
        })());
        // Local working-diff is only the fallback when there's no PR meta — only
        // then do we pay for base-branch resolution + a diff.
        if (!meta) {
            tasks.push((async () => {
                const baseRef = await git(rootPath, "symbolic-ref --short refs/remotes/origin/HEAD");
                if (!baseRef) { return; }
                const base = baseRef.startsWith("origin/") ? baseRef : `origin/${baseRef}`;
                localDiff = await git(rootPath, `diff --shortstat ${base}...HEAD`);
            })());
        }
    }

    // tmux session uptime (both kinds can have a live session)
    tasks.push((async () => {
        const created = await (async () => {
            try {
                const { stdout } = await execAsync(`tmux display-message -t "=${tmuxName}:" -p '#{session_created}'`, { timeout: 3000 });
                return parseInt(stdout.trim(), 10);
            } catch { return NaN; }
        })();
        if (!isNaN(created) && created > 0) {
            sessionUptime = fmtDuration(Date.now() / 1000 - created);
        }
    })());

    await Promise.all(tasks);

    // --- assemble ---
    const md = new MarkdownString(undefined, true); // supportThemeIcons
    md.supportHtml = true; // for the colored diff spans
    md.isTrusted = true;

    // The row (and the hover header) already shows the project name, so we don't
    // repeat it as a bold heading — that read as a duplicate title. Lead with the
    // path (and a search marker for investigations) instead.
    md.appendMarkdown(`${isInvestigation ? "$(search) " : ""}_${escapeMd(rootPath)}_\n\n`);

    const lines: string[] = [];

    const jiraKey = extractJiraKey(meta?.title, branch);
    const jiraLink = jiraKey ? `[jira: ${jiraKey}](${JIRA_BASE}${jiraKey})` : undefined;
    const slackLink = slack ? `[Slack](${slack})` : undefined;

    // PR / status block. PR link (with author), Jira link, Slack link each on
    // their own line — Slack directly below Jira.
    if (meta) {
        const titleLink = prUrl
            ? `[#${meta.number} ${escapeMd(meta.title)}](${prUrl})`
            : `#${meta.number} ${escapeMd(meta.title)}`;
        lines.push(meta.author ? `${titleLink} · @${escapeMd(meta.author)}` : titleLink);
        if (jiraLink) { lines.push(jiraLink); }
        if (slackLink) { lines.push(slackLink); }
        if (meta.updatedAt) {
            const ageSec = (Date.now() - Date.parse(meta.updatedAt)) / 1000;
            if (!isNaN(ageSec) && ageSec >= 0) { lines.push(`$(history) updated ${fmtDuration(ageSec)} ago`); }
        }
    }
    const sw = statusWords(status);
    if (sw) { lines.push(sw); }
    if (meta) {
        // Diff size from the PR (GitHub's computed merge diff).
        lines.push(`$(diff) ${colored("+" + meta.additions, GREEN)} ${colored("−" + meta.deletions, RED)} · ${meta.changedFiles} file${meta.changedFiles === 1 ? "" : "s"}`);
        if (meta.totalThreads > 0) {
            lines.push(meta.unresolvedThreads > 0
                ? `$(comment) ${colored(`${meta.unresolvedThreads}/${meta.totalThreads} threads unresolved`, RED)}`
                : `$(check) ${colored(`all ${meta.totalThreads} thread${meta.totalThreads === 1 ? "" : "s"} resolved`, GREEN)}`);
        }
        if (meta.mergeable === "CONFLICTING") { lines.push(`$(warning) ${colored("conflicts with base", RED)}`); }
    } else if (localDiff) {
        // No PR — fall back to the local working diff vs base.
        const m = localDiff.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
        if (m) { lines.push(`$(diff) ${colored("+" + (m[ 2 ] ?? 0), GREEN)} ${colored("−" + (m[ 3 ] ?? 0), RED)} · ${m[ 1 ]} file${m[ 1 ] === "1" ? "" : "s"} (uncommitted vs base)`); }
    }

    if (lines.length) { md.appendMarkdown(lines.join("\n\n") + "\n\n"); }

    // git / local block
    const gitLines: string[] = [];
    if (branch) { gitLines.push(`$(git-branch) ${escapeMd(branch)}`); }
    const flags: string[] = [];
    if (dirtyCount > 0) { flags.push(`$(pencil) ${dirtyCount} uncommitted`); }
    if (unpushed && unpushed !== "0") { flags.push(`$(cloud-upload) ${unpushed} unpushed`); }
    if (flags.length) { gitLines.push(flags.join(" · ")); }
    if (gitLines.length) { md.appendMarkdown(gitLines.join("\n\n") + "\n\n"); }

    // session / claude block
    const sessLines: string[] = [];
    if (sessionUptime) {
        const claude = needsInput ? "$(bell) waiting for input"
            : thinking ? "$(loading~spin) working"
                : "idle";
        sessLines.push(`$(terminal) tmux up ${sessionUptime} · ${claude}`);
    } else if (needsInput || thinking) {
        sessLines.push(needsInput ? "$(bell) Claude waiting for input" : "$(loading~spin) Claude working");
    }
    if (sessLines.length) { md.appendMarkdown(sessLines.join("\n\n") + "\n\n"); }

    // links footer. When there's an open PR the Jira link already sits next to
    // the PR title above; otherwise (merged / no open PR) show Jira here, beside
    // the Open PR link so the two stay adjacent.
    // For an open PR these links already sit in the PR block above; the footer
    // only carries them when there's no open PR (merged / no PR at all).
    const links: string[] = [];
    if (!meta && jiraLink) { links.push(jiraLink); }
    if (!meta && slackLink) { links.push(slackLink); }
    if (prUrl && !meta) { links.push(`[Open PR](${prUrl})`); }
    if (links.length) { md.appendMarkdown(links.join("\n\n")); }

    cache.set(rootPath, { ts: Date.now(), md });
    return md;
}
