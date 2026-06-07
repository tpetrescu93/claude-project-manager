import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface JiraCredentials {
    baseUrl: string;
    username: string;
    apiToken: string;
}

function loadCredentials(): JiraCredentials | undefined {
    try {
        const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
        const d = JSON.parse(raw);
        const env = d?.mcpServers?.atlassian?.env ?? {};
        const baseUrl = env.JIRA_URL?.replace(/\/$/, "");
        const username = env.JIRA_USERNAME;
        const apiToken = env.JIRA_API_TOKEN;
        if (!baseUrl || !username || !apiToken) { return undefined; }
        return { baseUrl, username, apiToken };
    } catch { return undefined; }
}

function authHeader(creds: JiraCredentials): string {
    return "Basic " + Buffer.from(`${creds.username}:${creds.apiToken}`).toString("base64");
}

export interface JiraDoneTransition {
    id: string;
    name: string;
}

/** Returns all available transitions that lead to a "done" category, preferred match first. */
export async function findDoneTransitions(issueKey: string): Promise<JiraDoneTransition[]> {
    const creds = loadCredentials();
    if (!creds) { return []; }

    const resp = await fetch(`${creds.baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
        headers: { "Authorization": authHeader(creds), "Accept": "application/json" },
    });
    if (!resp.ok) { return []; }

    const data = await resp.json() as { transitions: Array<{ id: string; name: string; to: { statusCategory: { key: string } } }> };
    const all = data.transitions.filter(t => t.to?.statusCategory?.key === "done");
    const DONE_RE = /^(done|resolved|closed|completed?)$/i;
    // Sort: regex matches first, rest alphabetically after.
    return all.sort((a, b) => {
        const aMatch = DONE_RE.test(a.name);
        const bMatch = DONE_RE.test(b.name);
        if (aMatch && !bMatch) { return -1; }
        if (!aMatch && bMatch) { return 1; }
        return a.name.localeCompare(b.name);
    }).map(t => ({ id: t.id, name: t.name }));
}

/** Transitions the issue to the given transition ID. */
export async function transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const creds = loadCredentials();
    if (!creds) { throw new Error("Jira credentials not found in ~/.claude.json"); }

    const resp = await fetch(`${creds.baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
        method: "POST",
        headers: {
            "Authorization": authHeader(creds),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!resp.ok && resp.status !== 204) {
        throw new Error(`Jira transition failed: HTTP ${resp.status}`);
    }
}
