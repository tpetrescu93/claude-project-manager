/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { OutputChannel, window } from "vscode";
import { spawn } from "child_process";
import { deleteSlackPost, getSlackPost } from "./slackPostStore";

let output: OutputChannel | undefined;
function log(): OutputChannel {
    if (!output) { output = window.createOutputChannel("Project Manager: Slack React"); }
    return output;
}

function runClaude(cwd: string, prompt: string): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(
            "claude",
            [ "-p", prompt, "--dangerously-skip-permissions" ],
            { cwd, shell: false }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (err) => resolve({ ok: false, code: null, stdout, stderr: stderr + err.message }));
        child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
}

export async function reactToMergedPr(rootPath: string): Promise<void> {
    const permalink = getSlackPost(rootPath);
    if (!permalink) { return; }

    const channel = log();
    channel.appendLine(`\n=== ${new Date().toISOString()} :: ${rootPath} merged ===`);
    channel.appendLine(`permalink: ${permalink}`);

    const result = await runClaude(
        rootPath,
        `Use the pr-slack-react skill to add the :merged: reaction to this Slack message: ${permalink}`
    );
    channel.appendLine(`exit code: ${result.code}`);
    if (result.stdout) { channel.appendLine(`--- stdout ---\n${result.stdout}`); }
    if (result.stderr) { channel.appendLine(`--- stderr ---\n${result.stderr}`); }

    if (result.ok) {
        deleteSlackPost(rootPath);
        channel.appendLine("reaction added; cleared stored permalink");
    } else {
        channel.appendLine("reaction failed; keeping permalink for manual retry");
    }
}
