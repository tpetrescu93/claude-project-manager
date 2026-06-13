/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as fs from "fs";
import * as path from "path";
import { Container } from "../core/container";
import { REPOS_BASE } from "../core/constants";

const LIST_KEY = "gitRepoList";
const SEEDED_KEY = "gitRepoListSeeded";

/** The curated list of canonical git repo rootPaths shown in the Git view. */
export function getGitRepoList(): string[] {
    return Container.context.globalState.get<string[]>(LIST_KEY, []);
}

export async function setGitRepoList(paths: string[]): Promise<void> {
    await Container.context.globalState.update(LIST_KEY, paths);
}

export async function addToGitRepoList(rootPath: string): Promise<void> {
    const list = getGitRepoList();
    if (!list.includes(rootPath)) { await setGitRepoList([ ...list, rootPath ]); }
}

export async function removeFromGitRepoList(rootPath: string): Promise<void> {
    const list = getGitRepoList();
    if (list.includes(rootPath)) { await setGitRepoList(list.filter(p => p !== rootPath)); }
}

/**
 * One-time seed: populate the list from the git repos already present in REPOS_BASE.
 * Guarded by a marker so an intentionally-emptied list is never re-seeded.
 */
export async function seedGitRepoListOnce(): Promise<void> {
    if (Container.context.globalState.get<boolean>(SEEDED_KEY, false)) { return; }
    let repos: string[] = [];
    try {
        repos = fs.readdirSync(REPOS_BASE, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(REPOS_BASE, e.name, ".git")))
            .map(e => path.join(REPOS_BASE, e.name))
            .sort();
    } catch { /* REPOS_BASE missing — seed empty */ }
    if (getGitRepoList().length === 0) { await setGitRepoList(repos); }
    await Container.context.globalState.update(SEEDED_KEY, true);
}
