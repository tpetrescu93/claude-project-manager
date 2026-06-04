import { OutputChannel, window } from "vscode";
import { spawn } from "child_process";
import { deleteSlackPost, getSlackPost } from "./slackPostStore";
import { snapshotSessionFiles, cleanupNewSessions } from "./claudeSessions";

let output: OutputChannel | undefined;
function log(): OutputChannel {
    if (!output) { output = window.createOutputChannel("Project Manager: Slack React"); }
    return output;
}

function runClaude(cwd: string, prompt: string): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
    // Delete the throwaway transcript this headless run creates so it doesn't
    // pollute the project's session history (Fork/resume pick the newest session).
    const before = snapshotSessionFiles(cwd);
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
        child.on("error", (err) => { cleanupNewSessions(cwd, before); resolve({ ok: false, code: null, stdout, stderr: stderr + err.message }); });
        child.on("close", (code) => { cleanupNewSessions(cwd, before); resolve({ ok: code === 0, code, stdout, stderr }); });
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
