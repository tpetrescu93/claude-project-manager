/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { commands, l10n, window } from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode } from "../sidebar/nodes";
import { exec } from "child_process";
import { promisify } from "util";
import { pendingDir } from "./pendingProjectStore";

const execAsync = promisify(exec);

export async function run(cmd: string, cwd: string): Promise<string> {
    const { stdout } = await execAsync(cmd, { cwd });
    return stdout.trim();
}

/**
 * Validates a branch name for the input box.
 */
export function validateBranchName(value: string): string | undefined {
    if (!value || !value.trim()) {
        return l10n.t("Branch name is required");
    }
    if (/[^a-zA-Z0-9\-_./]/.test(value)) {
        return l10n.t("Invalid characters in branch name");
    }
    return undefined;
}


function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn a detached bash script that clones sourcePath → targetDir on a new
 * branch and writes a pending-project file on success, so the project appears
 * in the list even if the user switched workspaces mid-run.
 */
export function spawnDetachedClone(opts: {
    sourcePath: string;
    targetDir: string;
    branchName: string;
    pendingId: string;
    sessionId?: string;         // fork: source session to copy
    sessionSrcDir?: string;     // fork: ~/.claude/projects/<encoded-source>
    sessionDstDir?: string;     // fork: ~/.claude/projects/<encoded-target>
    invSessionToKill?: string;  // promote: tmux session name to kill after clone
    kind?: string;              // promote: "investigation" to remove after clone
}) {
    const { sourcePath, targetDir, branchName, pendingId,
            sessionId, sessionSrcDir, sessionDstDir,
            invSessionToKill, kind } = opts;

    const pendingFile = shellQuote(path.join(pendingDir(), `${pendingId}.json`));
    const logFile = shellQuote(path.join(os.homedir(), ".project-manager", "clone-logs", `${pendingId}.log`));
    const repoName = path.basename(sourcePath);
    const pendingJson = JSON.stringify({ name: branchName, rootPath: targetDir, kind: kind ?? undefined, repoName });

    const sessionBlock = sessionId && sessionSrcDir && sessionDstDir ? `
# 5. Copy Claude session (cwd-rewritten so --resume operates in the new folder)
mkdir -p ${shellQuote(sessionDstDir)}
srcJsonl=${shellQuote(path.join(sessionSrcDir, `${sessionId}.jsonl`))}
dstJsonl=${shellQuote(path.join(sessionDstDir, `${sessionId}.jsonl`))}
if [ -f "$srcJsonl" ]; then
    jq -c --arg cwd ${shellQuote(targetDir)} 'if has("cwd") then .cwd = $cwd else . end' "$srcJsonl" > "$dstJsonl"
    srcSub=${shellQuote(path.join(sessionSrcDir, sessionId))}
    dstSub=${shellQuote(path.join(sessionDstDir, sessionId))}
    if [ -d "$srcSub" ]; then
        find "$srcSub" -type f | while IFS= read -r f; do
            rel="\${f#$srcSub/}"
            dst="$dstSub/$rel"
            mkdir -p "$(dirname "$dst")"
            if echo "$f" | grep -q '\\.jsonl$'; then
                jq -c --arg cwd ${shellQuote(targetDir)} 'if has("cwd") then .cwd = $cwd else . end' "$f" > "$dst"
            else
                cp "$f" "$dst" 2>/dev/null || true
            fi
        done
    fi
fi

# 6. Start tmux session resuming the copied Claude session
sessionName=$(basename ${shellQuote(targetDir)} | tr '.' '-')
tmux new-session -d -s "=$sessionName" -c ${shellQuote(targetDir)} bash -lic ${shellQuote(`claude --resume ${sessionId} --dangerously-skip-permissions`)} 2>/dev/null || true
` : `
# 5. (No session to copy)
`;

    const killBlock = invSessionToKill ? `
# Post-clone: kill investigation tmux session
tmux kill-session -t ${shellQuote("=" + invSessionToKill)} 2>/dev/null || true
` : "";

    const errorFile = shellQuote(path.join(pendingDir(), `${pendingId}.error`));
    const script = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname ${logFile})"
exec >> ${logFile} 2>&1

_on_error() {
    local line=$1
    local msg="Failed at line $line — see log: $(eval echo ${logFile})"
    printf '%s' ${shellQuote(JSON.stringify({ id: pendingId, message: "__MSG__", logFile: path.join(os.homedir(), ".project-manager", "clone-logs", `${pendingId}.log`) }))} \
        | sed "s|__MSG__|$msg|" > $(eval echo ${errorFile})
}
trap '_on_error $LINENO' ERR

echo "=== clone started $(date) ==="

# 1. Local git clone — hardlinks .git objects, ~5x faster than rsync
git clone ${shellQuote(sourcePath)} ${shellQuote(targetDir)}

# 2. Fetch + reset to canonical default branch so we're always up to date
cd ${shellQuote(targetDir)}
git fetch origin
defaultBranch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || true)
if [ -z "$defaultBranch" ]; then
    for b in main master develop; do
        if git rev-parse --verify "origin/$b" >/dev/null 2>&1; then defaultBranch="$b"; break; fi
    done
fi
git checkout -f "$defaultBranch"
git reset --hard "origin/$defaultBranch"

# 3. Create new branch
git checkout -b ${shellQuote(branchName)}

# 4. .venv: copy symlink if source has one, otherwise symlink the real dir
src_venv=${shellQuote(sourcePath)}/.venv
if [ -L "$src_venv" ]; then
    cp -P "$src_venv" .venv
elif [ -d "$src_venv" ]; then
    ln -s "$src_venv" .venv
fi

# 5. bun install if JS lockfile present
if [ -f yarn.lock ] || [ -f package-lock.json ]; then
    bun install && rm -f bun.lock bun.lockb || true
fi
${sessionBlock}${killBlock}
# Write pending file — signals the extension that the project is ready.
mkdir -p "$(dirname ${pendingFile})"
printf '%s' ${shellQuote(pendingJson)} > ${pendingFile}
echo "=== done $(date) ==="
`;

    fs.mkdirSync(path.join(os.homedir(), ".project-manager", "clone-logs"), { recursive: true });
    const child = spawn("bash", [ "-lc", script ], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
}

async function cloneProject(node: ProjectNode, projectStorage: ProjectStorage) {
    const sourcePath = node.preview.path;

    const input = await window.showInputBox({
        prompt: l10n.t("Branch name for the new project"),
        placeHolder: "my-feature-branch",
        validateInput: validateBranchName
    });
    if (!input) { return; }
    const branchName = input.trim();

    const sourceName = path.basename(sourcePath);
    const targetDir = path.join(path.dirname(sourcePath), `${sourceName}-${branchName}`);
    const pendingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    spawnDetachedClone({ sourcePath, targetDir, branchName, pendingId });
    window.showInformationMessage(
        l10n.t("Cloning in the background — \"{0}\" will appear in Projects when done.", path.basename(targetDir))
    );
}

export function registerCloneProject(projectStorage: ProjectStorage) {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.cloneProject", (node: ProjectNode) => cloneProject(node, projectStorage))
    );
}
