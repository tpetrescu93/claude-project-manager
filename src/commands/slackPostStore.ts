import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Container } from "../core/container";

/**
 * Slack permalinks are stored as one small file per project under
 *   ~/.project-manager/slack-posts/<encoded-rootPath>.url
 *
 * File-backed (not globalState) on purpose: the "Post to Slack" run is a
 * detached process that must record its own result even after a workspace
 * switch tears down the extension host — and an external process can't write
 * the extension's globalState. getSlackPost reads the file fresh each call, so
 * a detached write surfaces on the next status poll without a reload.
 */

const BASE = path.join(os.homedir(), ".project-manager", "slack-posts");
const LEGACY_KEY = "slackPostsByRootPath";

function encode(rootPath: string): string {
    return rootPath.replace(/\//g, "-");
}

export function slackPostFilePath(rootPath: string): string {
    return path.join(BASE, `${encode(rootPath)}.url`);
}

/** One-time per-key migration from the old globalState store. */
function migrateLegacy(rootPath: string): string | undefined {
    try {
        const legacy = Container.context.globalState.get<Record<string, string>>(LEGACY_KEY, {});
        const v = legacy[ rootPath ];
        if (v) {
            setSlackPost(rootPath, v);
            return v;
        }
    } catch { /* ignore */ }
    return undefined;
}

export function getSlackPost(rootPath: string): string | undefined {
    try {
        const p = slackPostFilePath(rootPath);
        if (fs.existsSync(p)) {
            const v = fs.readFileSync(p, "utf8").trim();
            return v || undefined;
        }
    } catch { /* ignore */ }
    return migrateLegacy(rootPath);
}

export function setSlackPost(rootPath: string, permalink: string): void {
    try {
        fs.mkdirSync(BASE, { recursive: true });
        fs.writeFileSync(slackPostFilePath(rootPath), permalink);
    } catch { /* ignore */ }
}

export function deleteSlackPost(rootPath: string): void {
    try { fs.rmSync(slackPostFilePath(rootPath), { force: true }); } catch { /* ignore */ }
    // Drop any leftover legacy globalState entry too.
    try {
        const legacy = Container.context.globalState.get<Record<string, string>>(LEGACY_KEY, {});
        if (rootPath in legacy) {
            delete legacy[ rootPath ];
            Container.context.globalState.update(LEGACY_KEY, legacy);
        }
    } catch { /* ignore */ }
}
