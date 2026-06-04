import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Completed clone/fork/promote operations write a small JSON file here so the
 * result survives an extension-host reload (workspace switch mid-operation).
 * The extension reconciles these on activation and via fs.watch + a 5s interval.
 */
const PENDING_DIR = path.join(os.homedir(), ".project-manager", "pending-projects");

export interface PendingProject {
    name: string;
    rootPath: string;
    kind?: string;
    repoName?: string;
}

export function pendingDir(): string {
    return PENDING_DIR;
}

export function writePendingProject(id: string, project: PendingProject): void {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, `${id}.json`), JSON.stringify(project));
}

export interface PendingError {
    id: string;
    message: string;
    logFile: string;
}

/** Read + delete all pending project files atomically. */
export function drainPendingProjects(): PendingProject[] {
    const results: PendingProject[] = [];
    let files: string[];
    try { files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith(".json")); }
    catch { return []; }
    for (const f of files) {
        const fp = path.join(PENDING_DIR, f);
        try {
            const data = JSON.parse(fs.readFileSync(fp, "utf8")) as PendingProject;
            results.push(data);
            fs.rmSync(fp, { force: true });
        } catch { /* skip corrupt entries */ }
    }
    return results;
}

/** Read + delete all error files, returning one entry per failed operation. */
export function drainPendingErrors(): PendingError[] {
    const results: PendingError[] = [];
    let files: string[];
    try { files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith(".error")); }
    catch { return []; }
    for (const f of files) {
        const fp = path.join(PENDING_DIR, f);
        try {
            const data = JSON.parse(fs.readFileSync(fp, "utf8")) as PendingError;
            results.push(data);
            fs.rmSync(fp, { force: true });
        } catch { /* skip corrupt entries */ }
    }
    return results;
}
