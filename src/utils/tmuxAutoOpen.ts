/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Container } from "../core/container";

const KEY = "tmuxAutoOpened";

/**
 * Remove a project from the tmux auto-opened set (the rootPaths whose tmux tab
 * has already been auto-opened once, tracked in extension.ts). Call on deletion
 * so the entry doesn't leak, and so a future project at the same path auto-opens
 * as new.
 */
export function forgetTmuxAutoOpened(rootPath: string): void {
    const opened = Container.context.globalState.get<string[]>(KEY, []);
    if (opened.includes(rootPath)) {
        Container.context.globalState.update(KEY, opened.filter(p => p !== rootPath));
    }
}
