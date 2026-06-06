import { execSync } from "child_process";

const MCP_URL = "https://mcp.ai.corp.stream.co/slack/mcp";
const CRED_SERVICE = "Claude Code-credentials";

let cachedToken: string | undefined;

function loadToken(): string | undefined {
    if (cachedToken) { return cachedToken; }
    try {
        const raw = execSync(`security find-generic-password -s ${JSON.stringify(CRED_SERVICE)} -w`, { timeout: 5000 }).toString().trim();
        const creds = JSON.parse(raw);
        const mcpOAuth = creds.mcpOAuth ?? {};
        for (const [key, value] of Object.entries(mcpOAuth) as [string, any][]) {
            if (key.startsWith("slack|")) {
                const token = value?.accessToken;
                if (token) { cachedToken = token; return token; }
            }
        }
    } catch { /* keychain unavailable or no token */ }
    return undefined;
}

/** Invalidate cached token (e.g. on 401). */
export function invalidateSlackToken(): void {
    cachedToken = undefined;
}

/**
 * Call a Slack MCP tool directly over HTTP — no claude -p needed.
 * Returns the parsed result object, or throws on error.
 */
export async function callSlackTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    const token = loadToken();
    if (!token) { throw new Error("No Slack MCP token found — ensure Claude Code is authenticated with the Slack MCP."); }

    const resp = await fetch(MCP_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    });

    if (resp.status === 401) {
        invalidateSlackToken();
        throw new Error("Slack MCP token expired or invalid. Re-authenticate via `claude mcp`.");
    }
    if (!resp.ok) { throw new Error(`Slack MCP HTTP ${resp.status}`); }

    // Response is SSE — grab the single data line.
    const body = await resp.text();
    const dataLine = body.split("\n").find(l => l.startsWith("data:"));
    if (!dataLine) { throw new Error("Unexpected Slack MCP response format"); }

    const envelope = JSON.parse(dataLine.slice(5).trim());
    if (envelope.error) { throw new Error(`Slack MCP error: ${envelope.error.message}`); }

    const result = envelope.result;
    if (result?.isError) {
        const msg = result.content?.[0]?.text ?? "Unknown Slack MCP error";
        throw new Error(msg);
    }

    // Return structured content if available, otherwise parse the text field.
    return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? "{}");
}

/** Post a message and return { ts, channel, permalink }. */
export async function slackPostMessage(channelId: string, text: string, options: { unfurlLinks?: boolean } = {}): Promise<{ ts: string; channel: string; permalink: string }> {
    const result = await callSlackTool("post_message", {
        channel_id: channelId,
        text,
        unfurl_links: options.unfurlLinks ?? false,
        unfurl_media: false,
    });
    const ts: string = result.ts ?? result.message?.ts;
    const channel: string = result.channel;
    const permalink = `https://wagestream.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
    return { ts, channel, permalink };
}

/** Add a reaction to a message identified by a Slack permalink. */
export async function slackAddReaction(permalink: string, reactionName: string): Promise<void> {
    // Parse channel + ts from permalink: .../archives/<channel>/p<ts_no_dot>
    const m = permalink.match(/\/archives\/([^/]+)\/p(\d{10})(\d+)/);
    if (!m) { throw new Error(`Cannot parse Slack permalink: ${permalink}`); }
    const channel = m[1];
    const ts = `${m[2]}.${m[3]}`;
    await callSlackTool("add_reaction", { channel, timestamp: ts, name: reactionName });
}
