/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { exec } from "child_process";
import { promisify } from "util";
import { PrStatus } from "./projectStatuses";

const execAsync = promisify(exec);

const GRAPHQL_URL = "https://api.github.com/graphql";
const FETCH_TIMEOUT_MS = 10_000;
const MERGED_WINDOW_DAYS = 30;

let cachedToken: string | undefined;

async function getGhToken(): Promise<string | undefined> {
    if (cachedToken) { return cachedToken; }
    try {
        const { stdout } = await execAsync("gh auth token", { timeout: 5000 });
        const t = stdout.trim();
        if (!t) { return undefined; }
        cachedToken = t;
        return t;
    } catch {
        return undefined;
    }
}

export function parseRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | undefined {
    // git@github.com:owner/repo(.git)?
    let m = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) { return { owner: m[ 1 ], repo: m[ 2 ] }; }
    // https://[token@]github.com/owner/repo(.git)?
    m = remoteUrl.match(/https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/|$)/);
    if (m) { return { owner: m[ 1 ], repo: m[ 2 ] }; }
    return undefined;
}

export interface BulkFetchInput {
    rootPath: string;
    owner: string;
    repo: string;
    branch: string;
}

export interface BulkFetchResult {
    status: PrStatus;
    url?: string;
}

function escapeGraphqlString(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function prsToStatus(prs: any[]): BulkFetchResult {
    if (!prs || prs.length === 0) { return { status: "no_pr" }; }
    // Prefer OPEN over MERGED. GraphQL doesn't guarantee ordering across states,
    // so pick explicitly.
    const open = prs.find(p => p.state === "OPEN");
    if (open) {
        if (open.mergeable === "CONFLICTING") { return { status: "open_conflicting", url: open.url }; }
        if (open.reviewDecision === "CHANGES_REQUESTED") { return { status: "changes_requested", url: open.url }; }
        const rollup = open.statusCheckRollup?.state;
        if (rollup === "PENDING" || rollup === "EXPECTED") { return { status: "open_pending", url: open.url }; }
        if (rollup === "FAILURE" || rollup === "ERROR") { return { status: "open_failing", url: open.url }; }
        // SUCCESS or no checks
        if (open.reviewDecision === "APPROVED") { return { status: "open_approved", url: open.url }; }
        return { status: "open_passing", url: open.url };
    }
    // No open PR — look at most recent merged
    const merged = prs
        .filter(p => p.state === "MERGED" && p.mergedAt)
        .sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime())[ 0 ];
    if (merged) {
        const ageDays = (Date.now() - new Date(merged.mergedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < MERGED_WINDOW_DAYS) { return { status: "merged", url: merged.url }; }
    }
    return { status: "no_pr" };
}

/**
 * Returns a Map of rootPath -> result for every input the API answered.
 * Returns undefined on auth/network/total failure so the caller preserves its cache.
 */
export async function bulkFetchPrStatuses(inputs: BulkFetchInput[]): Promise<Map<string, BulkFetchResult> | undefined> {
    if (inputs.length === 0) { return new Map(); }
    const token = await getGhToken();
    if (!token) { return undefined; }

    // Group by (owner, repo) so we issue one repository(...) block per repo
    // with N aliased pullRequests sub-queries underneath. Many wagestream
    // worktrees share the same repo, so grouping massively shrinks the query.
    const byRepo = new Map<string, BulkFetchInput[]>();
    for (const inp of inputs) {
        const key = `${inp.owner}/${inp.repo}`;
        const arr = byRepo.get(key);
        if (arr) { arr.push(inp); } else { byRepo.set(key, [ inp ]); }
    }

    let query = "query {";
    const repoAliasMap = new Map<string, BulkFetchInput[]>();
    let repoIdx = 0;
    for (const items of byRepo.values()) {
        const alias = `r${repoIdx++}`;
        repoAliasMap.set(alias, items);
        const owner = escapeGraphqlString(items[ 0 ].owner);
        const repo = escapeGraphqlString(items[ 0 ].repo);
        query += ` ${alias}: repository(owner:"${owner}", name:"${repo}") {`;
        items.forEach((item, i) => {
            const branch = escapeGraphqlString(item.branch);
            query += ` p${i}: pullRequests(headRefName:"${branch}", states:[OPEN,MERGED], orderBy:{field:UPDATED_AT,direction:DESC}, first:3) { nodes { number url state mergeable reviewDecision mergedAt statusCheckRollup { state } } }`;
        });
        query += " }";
    }
    query += " }";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let respBody: any;
    try {
        const resp = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
                "Authorization": `bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "vscode-project-manager-fork",
            },
            body: JSON.stringify({ query }),
            signal: controller.signal,
        });
        if (resp.status === 401) {
            cachedToken = undefined; // force re-fetch of token next cycle
            return undefined;
        }
        if (!resp.ok) { return undefined; }
        respBody = await resp.json();
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }

    if (!respBody?.data) { return undefined; }

    const results = new Map<string, BulkFetchResult>();
    for (const [ alias, items ] of repoAliasMap) {
        const repoData = respBody.data[ alias ];
        if (!repoData) {
            // Repo-level error (e.g. repo doesn't exist / no access). Mark each as no_pr
            // so the caller doesn't keep showing stale state — but only if the cache
            // already had something different, the caller handles diffing.
            for (const item of items) {
                results.set(item.rootPath, { status: "no_pr" });
            }
            continue;
        }
        items.forEach((item, i) => {
            const prList = repoData[ `p${i}` ]?.nodes || [];
            results.set(item.rootPath, prsToStatus(prList));
        });
    }
    return results;
}

export function invalidateGhTokenCache(): void {
    cachedToken = undefined;
}
