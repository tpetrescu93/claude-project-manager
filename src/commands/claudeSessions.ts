import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Helpers for Claude Code's per-project session store at
 *   ~/.claude/projects/<cwd with / replaced by ->/<session-id>.jsonl
 *
 * Used to keep headless `claude -p` runs (pr-slack, merge-react) from polluting
 * a project's session history — otherwise their throwaway transcripts become the
 * "newest" session and get picked up by Fork / resume.
 */

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function encodeProjectDir(rootPath: string): string {
    return rootPath.replace(/\//g, "-");
}

export function projectSessionDir(rootPath: string): string {
    return path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(rootPath));
}

/** Snapshot the set of session jsonl filenames currently in the project's dir. */
export function snapshotSessionFiles(rootPath: string): Set<string> {
    try {
        return new Set(fs.readdirSync(projectSessionDir(rootPath)).filter(f => f.endsWith(".jsonl")));
    } catch {
        return new Set();
    }
}

/**
 * Delete any session jsonl (and its subagent dir) that appeared since `before`.
 * Call after a headless `claude -p` run to remove the transcript it created.
 */
export function cleanupNewSessions(rootPath: string, before: Set<string>): void {
    const dir = projectSessionDir(rootPath);
    let now: string[];
    try {
        now = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    } catch {
        return;
    }
    for (const f of now) {
        if (before.has(f)) { continue; }
        const id = f.replace(/\.jsonl$/, "");
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(path.join(dir, id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
