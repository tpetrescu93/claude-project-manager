/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { commands, l10n, window } from "vscode";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { Container } from "../core/container";
import { ProjectNode } from "../sidebar/nodes";
import { getPrUrlForPath } from "./projectStatuses";
import { getSlackPost, deleteSlackPost, slackPostFilePath } from "./slackPostStore";
import { projectSessionDir, encodeProjectDir } from "./claudeSessions";
import { pendingDir } from "./pendingProjectStore";

const POST_PROMPT = "Use the pr-slack skill to post the current branch's PR to Slack. Do not ask for confirmation.";

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a self-contained bash script that posts to Slack and records the result
 * ITSELF — so it survives a workspace switch tearing down the extension host.
 * It runs `claude -p`, greps the SLACK_POST permalink, writes it to the project's
 * store file, logs the full output, and deletes the throwaway session transcript
 * the headless run created (snapshot/diff in-shell, since the JS close handler
 * would die with the ext host).
 */
function buildPostScript(rootPath: string): string {
    const store = shellQuote(slackPostFilePath(rootPath));
    const logAbsolute = path.join(os.homedir(), ".project-manager", "slack-logs", `${encodeProjectDir(rootPath)}.log`);
    const logFile = shellQuote(logAbsolute);
    const pendingId = `slack-${encodeProjectDir(rootPath).slice(-20)}`;
    const errorFile = shellQuote(path.join(pendingDir(), `${pendingId}.error`));
    const errorJson = shellQuote(JSON.stringify({ id: pendingId, message: "Failed to post PR to Slack — no permalink found. Check the log for details.", logFile: logAbsolute }));
    const sdir = shellQuote(projectSessionDir(rootPath));
    const cwd = shellQuote(rootPath);
    const prompt = shellQuote(POST_PROMPT);
    return [
        `mkdir -p "$(dirname ${store})" "$(dirname ${logFile})" "$(dirname ${errorFile})" 2>/dev/null`,
        `sdir=${sdir}`,
        `before="|"; for f in "$sdir"/*.jsonl; do [ -e "$f" ] && before="$before$f|"; done`,
        `out=$(cd ${cwd} && claude -p ${prompt} --dangerously-skip-permissions 2>&1)`,
        `printf '%s\\n' "$out" > ${logFile}`,
        `url=$(printf '%s\\n' "$out" | grep -oE '^SLACK_POST:[[:space:]]*https?://[^[:space:]]+' | head -1 | sed -E 's/^SLACK_POST:[[:space:]]*//')`,
        `if [ -n "$url" ]; then printf '%s' "$url" > ${store}; else printf '%s' ${errorJson} > ${errorFile}; fi`,
        `for f in "$sdir"/*.jsonl; do [ -e "$f" ] || continue; case "$before" in *"|$f|"*) ;; *) rm -f "$f"; id=$(basename "$f" .jsonl); rm -rf "$sdir/$id";; esac; done`,
    ].join("\n");
}

async function postPrToSlack(node: ProjectNode) {
    const rootPath: string = node?.preview?.path ?? node?.command?.arguments?.[ 0 ];
    if (!rootPath) { return; }

    const url = getPrUrlForPath(rootPath);
    if (!url) {
        window.showWarningMessage(l10n.t("No open PR for this project."));
        return;
    }

    const confirmed = await window.showWarningMessage(
        l10n.t("Post this PR to Slack?\n\n{0}", url),
        { modal: true },
        l10n.t("Post")
    );
    if (!confirmed) { return; }

    // Detached + unref'd so the post completes and records itself even if you
    // switch workspaces (which reloads the extension host) before it finishes.
    // The row flips to the "posted to Slack" icon on the next status poll once
    // the script writes the permalink file.
    const child = spawn("bash", [ "-lc", buildPostScript(rootPath) ], {
        cwd: rootPath,
        detached: true,
        stdio: "ignore",
    });
    child.unref();

    window.showInformationMessage(
        l10n.t("Posting PR to Slack in the background — the row updates to the “posted” icon once it lands. Safe to switch workspaces.")
    );
}

async function removeSlackPost(node: ProjectNode) {
    const rootPath: string = node?.preview?.path ?? node?.command?.arguments?.[ 0 ];
    if (!rootPath) { return; }
    if (!getSlackPost(rootPath)) {
        window.showInformationMessage(l10n.t("No Slack link stored for this project."));
        return;
    }
    deleteSlackPost(rootPath);
    // The "posted to Slack" status is a poll-time overlay derived from the stored
    // link, so the icon reverts to plain "passing" on the next status poll (~6s).
    // Removing the link also means the merged-PR reaction won't fire for this PR.
    window.showInformationMessage(l10n.t("Removed the Slack link for this project."));
}

export function registerPostPrToSlack() {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.postPrToSlack", (node: ProjectNode) => postPrToSlack(node)),
        commands.registerCommand("_projectManager.removeSlackPost", (node: ProjectNode) => removeSlackPost(node))
    );
}
