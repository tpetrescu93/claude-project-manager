/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { commands, l10n, OutputChannel, ProgressLocation, window } from "vscode";
import { spawn } from "child_process";
import { Container } from "../core/container";
import { ProjectNode } from "../sidebar/nodes";
import { getPrUrlForPath } from "./projectStatuses";
import { setSlackPost } from "./slackPostStore";

const SLACK_POST_MARKER = /^SLACK_POST:\s*(https?:\/\/\S+)/m;

let output: OutputChannel | undefined;
function log(): OutputChannel {
    if (!output) { output = window.createOutputChannel("Project Manager: Slack"); }
    return output;
}

interface RunResult { ok: boolean; code: number | null; stdout: string; stderr: string; }

function runClaude(rootPath: string, prompt: string): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = spawn(
            "claude",
            [ "-p", prompt, "--dangerously-skip-permissions" ],
            { cwd: rootPath, shell: false }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (err) => resolve({ ok: false, code: null, stdout, stderr: stderr + err.message }));
        child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
}

function summariseFailure(result: RunResult): string {
    // Claude's headless mode writes its final answer to stdout. If it failed
    // mid-task, the last few lines of stdout usually explain why; stderr
    // covers spawn/exec errors. Prefer stdout when it's non-empty.
    const source = result.stdout.trim() || result.stderr.trim();
    if (!source) { return l10n.t("Exit code {0} with no output", String(result.code)); }
    const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
    return lines[ lines.length - 1 ].slice(0, 200);
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

    await window.withProgress({
        location: ProgressLocation.Notification,
        title: l10n.t("Posting PR to Slack..."),
        cancellable: false
    }, async () => {
        const startedAt = new Date().toISOString();
        const channel = log();
        channel.appendLine(`\n=== ${startedAt} :: ${rootPath} ===`);
        channel.appendLine(`PR URL: ${url}`);
        const result = await runClaude(
            rootPath,
            "Use the pr-slack skill to post the current branch's PR to Slack. Do not ask for confirmation."
        );
        channel.appendLine(`exit code: ${result.code}`);
        if (result.stdout) { channel.appendLine(`--- stdout ---\n${result.stdout}`); }
        if (result.stderr) { channel.appendLine(`--- stderr ---\n${result.stderr}`); }

        if (result.ok) {
            const match = result.stdout.match(SLACK_POST_MARKER);
            if (match) {
                setSlackPost(rootPath, match[ 1 ]);
                channel.appendLine(`stored slack permalink: ${match[ 1 ]}`);
            } else {
                channel.appendLine("no SLACK_POST marker found in stdout — merge reaction will not fire for this PR");
            }
            window.showInformationMessage(l10n.t("Posted to Slack."));
        } else {
            const summary = summariseFailure(result);
            const choice = await window.showErrorMessage(
                l10n.t("Failed to post to Slack: {0}", summary),
                l10n.t("Show Logs")
            );
            if (choice) { channel.show(true); }
        }
    });
}

export function registerPostPrToSlack() {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.postPrToSlack", (node: ProjectNode) => postPrToSlack(node))
    );
}
