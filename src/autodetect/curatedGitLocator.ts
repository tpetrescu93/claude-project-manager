/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as path from "path";
import { codicons } from "vscode-ext-codicons";
import { CustomProjectLocator } from "./abstractLocator";
import { getGitRepoList, seedGitRepoListOnce } from "../commands/gitRepoStore";

/**
 * Git locator backed by an explicit, extension-managed list (globalState) rather
 * than scanning `baseFolders` on disk. The Git view therefore shows exactly the
 * repos the user registered (via "Add Git Repo"), not whatever happens to be on
 * disk. Everything else (the AutodetectProvider, drag-reorder, title count) keeps
 * working since it only reads `projectList`.
 */
export class CuratedGitLocator extends CustomProjectLocator {
    public async refreshProjects(): Promise<boolean> {
        await seedGitRepoListOnce();
        this.projectList = getGitRepoList().map(p => ({
            fullPath: p,
            name: path.basename(p),
            icon: codicons.git_branch,
        }));
        return true;
    }
}
