/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { Container } from "../core/container";

const PINNED_REPOS_KEY = "gitPinnedRepos";
const SHOW_PINNED_ONLY_KEY = "gitShowPinnedOnly";
const SHOW_PINNED_ONLY_CONTEXT = "projectManager.gitShowPinnedOnly";

const pinChangedEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
export const onDidPinChange = pinChangedEmitter.event;

export function isGitRepoPinned(rootPath: string): boolean {
    const pinned = Container.context.globalState.get<Record<string, true>>(PINNED_REPOS_KEY, {});
    return !!pinned[ rootPath ];
}

export function getPinnedGitRepos(): Set<string> {
    const pinned = Container.context.globalState.get<Record<string, true>>(PINNED_REPOS_KEY, {});
    return new Set(Object.keys(pinned));
}

export async function toggleGitRepoPin(rootPath: string): Promise<boolean> {
    const pinned = { ...Container.context.globalState.get<Record<string, true>>(PINNED_REPOS_KEY, {}) };
    const wasPinned = !!pinned[ rootPath ];
    if (wasPinned) {
        delete pinned[ rootPath ];
    } else {
        pinned[ rootPath ] = true;
    }
    await Container.context.globalState.update(PINNED_REPOS_KEY, pinned);
    pinChangedEmitter.fire(vscode.Uri.from({ scheme: 'projectManager-readonly-view', path: rootPath }));
    return !wasPinned;
}

export function isShowingPinnedOnly(): boolean {
    return Container.context.globalState.get<boolean>(SHOW_PINNED_ONLY_KEY, false);
}

export async function toggleShowPinnedOnly(): Promise<boolean> {
    const newValue = !isShowingPinnedOnly();
    await Container.context.globalState.update(SHOW_PINNED_ONLY_KEY, newValue);
    await vscode.commands.executeCommand("setContext", SHOW_PINNED_ONLY_CONTEXT, newValue);
    return newValue;
}

export async function initShowPinnedOnlyContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", SHOW_PINNED_ONLY_CONTEXT, isShowingPinnedOnly());
}
