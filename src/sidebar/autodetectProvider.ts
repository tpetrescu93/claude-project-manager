/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { execSync } from "child_process";
import { AutodetectedProjectInfo } from "../autodetect/autodetectedProjectInfo";
import { CustomProjectLocator } from "../autodetect/abstractLocator";
import { ProjectNode } from "./nodes";
import { Container } from "../core/container";
import { addParentFolderToDuplicates } from "../utils/path";
import { getPinnedGitRepos, isShowingPinnedOnly } from "../commands/gitPinning";

const REMOTE_URL_CACHE_KEY = "gitRemoteUrlCache";
let remoteUrlCache: Record<string, string> | undefined;

function loadRemoteUrlCache(): Record<string, string> {
    if (!remoteUrlCache) {
        remoteUrlCache = { ...Container.context.globalState.get<Record<string, string>>(REMOTE_URL_CACHE_KEY, {}) };
    }
    return remoteUrlCache;
}

function persistRemoteUrlCache(): void {
    Container.context.globalState.update(REMOTE_URL_CACHE_KEY, remoteUrlCache);
}

function getGitRemoteUrl(projectPath: string): string | undefined {
    const cache = loadRemoteUrlCache();
    if (cache[ projectPath ]) { return cache[ projectPath ]; }
    try {
        const url = execSync("git remote get-url origin", { cwd: projectPath, timeout: 5000 })
            .toString().trim();
        cache[ projectPath ] = url;
        persistRemoteUrlCache();
        return url;
    } catch {
        return undefined;
    }
}

const GIT_ITEM_ORDER_KEY = "gitItemOrder";

function getGitItemOrder(): string[] {
    return Container.context.globalState.get<string[]>(GIT_ITEM_ORDER_KEY, []);
}

async function moveGitItem(fromPath: string, toPath: string): Promise<void> {
    const order = [ ...getGitItemOrder() ];
    let fromIdx = order.indexOf(fromPath);
    let toIdx = order.indexOf(toPath);
    // Items not in the order list have an implicit position at the end.
    if (fromIdx < 0) {
        order.push(fromPath);
        fromIdx = order.length - 1;
    }
    if (toIdx < 0) {
        order.push(toPath);
        toIdx = order.length - 1;
    }
    if (fromIdx === toIdx) { return; }
    const [ moved ] = order.splice(fromIdx, 1);
    if (toIdx > fromIdx) { toIdx--; }
    order.splice(toIdx, 0, moved);
    await Container.context.globalState.update(GIT_ITEM_ORDER_KEY, order);
}

function sortByGitOrder(projects: AutodetectedProjectInfo[]): AutodetectedProjectInfo[] {
    const order = getGitItemOrder();
    if (order.length === 0) { return projects; }
    const positions = new Map<string, number>();
    order.forEach((p, i) => positions.set(p, i));
    return [ ...projects ].sort((a, b) => {
        const pa = positions.has(a.fullPath) ? positions.get(a.fullPath)! : Number.MAX_SAFE_INTEGER;
        const pb = positions.has(b.fullPath) ? positions.get(b.fullPath)! : Number.MAX_SAFE_INTEGER;
        if (pa !== pb) { return pa - pb; }
        // Both not in order list — fall back to alphabetical
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
}

export function deduplicateByRemote(projects: AutodetectedProjectInfo[]): AutodetectedProjectInfo[] {
    const remoteMap = new Map<string, AutodetectedProjectInfo>();

    for (const project of projects) {
        const remoteUrl = getGitRemoteUrl(project.fullPath);
        if (!remoteUrl) {
            remoteMap.set(project.fullPath, project);
            continue;
        }

        const existing = remoteMap.get(remoteUrl);
        if (!existing || project.fullPath.length < existing.fullPath.length) {
            remoteMap.set(remoteUrl, project);
        }
    }

    return [ ...remoteMap.values() ];
}

export class AutodetectProvider implements vscode.TreeDataProvider<ProjectNode>, vscode.TreeDragAndDropController<ProjectNode> {

    private static readonly DRAG_MIME_TYPE = "application/vnd.code.tree.projectsExplorerGit";

    public readonly dropMimeTypes: readonly string[] = [ AutodetectProvider.DRAG_MIME_TYPE ];
    public readonly dragMimeTypes: readonly string[] = [ AutodetectProvider.DRAG_MIME_TYPE ];

    public readonly onDidChangeTreeData: vscode.Event<ProjectNode | void>;

    private projectSource: CustomProjectLocator;
    private internalOnDidChangeTreeData: vscode.EventEmitter<ProjectNode | void> = new vscode.EventEmitter<ProjectNode | void>();

    constructor(projectSource: CustomProjectLocator) {
        this.projectSource = projectSource;
        this.onDidChangeTreeData = this.internalOnDidChangeTreeData.event;
    }

    public refresh(): void {
        this.internalOnDidChangeTreeData.fire();
    }

    public handleDrag(source: readonly ProjectNode[], dataTransfer: vscode.DataTransfer): void {
        if (this.projectSource.displayName !== "Git") { return; }
        const paths = source.map(n => n.preview.path);
        if (paths.length === 0) { return; }
        dataTransfer.set(AutodetectProvider.DRAG_MIME_TYPE, new vscode.DataTransferItem(paths));
    }

    public async handleDrop(target: ProjectNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        if (this.projectSource.displayName !== "Git") { return; }
        if (!target) { return; }
        const transferItem = dataTransfer.get(AutodetectProvider.DRAG_MIME_TYPE);
        if (!transferItem) { return; }
        const sourcePaths: string[] = transferItem.value;
        if (!sourcePaths || sourcePaths.length === 0) { return; }
        await moveGitItem(sourcePaths[ 0 ], target.preview.path);
        this.refresh();
    }

    public getTreeItem(element: ProjectNode): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: ProjectNode): Thenable<ProjectNode[]> {

        // loop !!!
        return new Promise(resolve => {

            if (element) {

                const ll: ProjectNode[] = [];

                ll.push(new ProjectNode(element.label, vscode.TreeItemCollapsibleState.None, "git", element.preview, {
                    command: "_projectManager.open",
                    title: "",
                    arguments: [ element.preview.path ],
                }));

                resolve(ll);

            } else {

                // ROOT

                // raw list
                const lll: ProjectNode[] = [];

                // Locators (VSCode/Git/Mercurial/SVN)
                // this.projectSource.initializeCfg(this.projectSource.kind);

                if (this.projectSource.projectList.length > 0) {

                    this.projectSource.projectList.sort((n1, n2) => {
                        if (n1.name.toLowerCase() > n2.name.toLowerCase()) {
                            return 1;
                        }

                        if (n1.name.toLowerCase() < n2.name.toLowerCase()) {
                            return -1;
                        }

                        return 0;
                    });

                    let deduplicated = deduplicateByRemote(this.projectSource.projectList);

                    const isGit = this.projectSource.displayName === "Git";
                    if (isGit && isShowingPinnedOnly()) {
                        const pinned = getPinnedGitRepos();
                        deduplicated = deduplicated.filter(p => pinned.has(p.fullPath));
                    }
                    if (isGit) {
                        deduplicated = sortByGitOrder(deduplicated);
                    }

                    const projectsWithParent = addParentFolderToDuplicates(deduplicated);

                    for (let index = 0; index < projectsWithParent.length; index++) {
                        const dirinfo = projectsWithParent[ index ];

                        lll.push(new ProjectNode(dirinfo.name, vscode.TreeItemCollapsibleState.None,
                            dirinfo.icon, {
                                name: dirinfo.name,
                                detail: dirinfo.parent,
                                path: dirinfo.path
                            }, isGit ? undefined : {
                                command: "_projectManager.open",
                                title: "",
                                arguments: [ dirinfo.path, dirinfo.name ],
                            }, !isGit));
                    }
                }

                resolve(lll);
            }
        });
    }

    public async showTreeView(): Promise<void> {

        // The "auto-detected" views depends if some project have been detected
        // this.projectSource.initializeCfg(this.projectSource.kind);
        if (!this.projectSource.isAlreadyLocated()) {
            await this.projectSource.locateProjects();
        }

        if (this.projectSource.displayName === "Git") {
            const hideGitWelcome = Container.context.globalState.get<boolean>("hideGitWelcome", false);
            vscode.commands.executeCommand("setContext", "projectManager.canShowTreeView" + this.projectSource.displayName,
                this.projectSource.projectList.length > 0 || !hideGitWelcome);
        } else {
            vscode.commands.executeCommand("setContext", "projectManager.canShowTreeView" + this.projectSource.displayName,
                this.projectSource.projectList.length > 0);
        }
        return;
    }

}
