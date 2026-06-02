/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import path = require("path");
import * as vscode from "vscode";
import { Container } from "../core/container";
import { ProjectStorage } from "../storage/storage";
import { PathUtils } from "../utils/path";
import { isRemotePath } from "../utils/remote";
import { sortProjects } from "../utils/sorter";
import { NO_TAGS_DEFINED } from "./constants";
import { NoTagNode, ProjectNode, TagNode, InvestigationNode } from "./nodes";
import { buildProjectTooltip } from "../commands/projectTooltip";

interface ProjectInQuickPick {
    label: string;
    description: string;
    profile: string;
    kind?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ProjectInQuickPickList extends Array<ProjectInQuickPick> { }

export class StorageProvider implements vscode.TreeDataProvider<ProjectNode | TagNode | InvestigationNode>, vscode.TreeDragAndDropController<ProjectNode | TagNode | InvestigationNode> {

    private static readonly DRAG_MIME_TYPE = "application/vnd.code.tree.projectsExplorerFavorites";

    public readonly dropMimeTypes: readonly string[] = [ StorageProvider.DRAG_MIME_TYPE ];
    public readonly dragMimeTypes: readonly string[] = [ StorageProvider.DRAG_MIME_TYPE ];

    public readonly onDidChangeTreeData: vscode.Event<ProjectNode | TagNode | InvestigationNode | void>;

    private projectSource: ProjectStorage;
    private internalOnDidChangeTreeData: vscode.EventEmitter<ProjectNode | TagNode | InvestigationNode | void> = new vscode.EventEmitter<ProjectNode | TagNode | InvestigationNode | void>();
    private nodesByPath = new Map<string, ProjectNode | InvestigationNode>();
    private static readonly TAGS_EXPANSION_STATE_KEY = "projectsExplorerFavorites.tagsExpansionState";

    constructor(projectSource: ProjectStorage) {
        this.projectSource = projectSource;
        this.onDidChangeTreeData = this.internalOnDidChangeTreeData.event;
    }

    private static getTagExpansionState(): Record<string, boolean> {
        return Container.context.globalState.get<Record<string, boolean>>(StorageProvider.TAGS_EXPANSION_STATE_KEY, {});
    }

    public static async resetTagExpansionState(): Promise<void> {
        await Container.context.globalState.update(StorageProvider.TAGS_EXPANSION_STATE_KEY, {});
    }

    public static getTagCollapsibleState(tagId: string, behavior: string): vscode.TreeItemCollapsibleState {
        switch (behavior) {
            case "alwaysExpanded":
                return vscode.TreeItemCollapsibleState.Expanded;
            case "alwaysCollapsed":
                return vscode.TreeItemCollapsibleState.Collapsed;
            case "startExpanded":
            case "startCollapsed": {
                const expansionState = StorageProvider.getTagExpansionState();
                const isExpanded = expansionState[ tagId ];
                if (isExpanded === undefined) {
                    return behavior === "startExpanded" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
                }
                return isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
            }
            default:
                return vscode.TreeItemCollapsibleState.Expanded;
        }
    }

    public static async setTagExpanded(tagId: string, expanded: boolean): Promise<void> {
        const expansionState = StorageProvider.getTagExpansionState();
        const newExpansionState = { ...expansionState, [ tagId ]: expanded };
        await Container.context.globalState.update(StorageProvider.TAGS_EXPANSION_STATE_KEY, newExpansionState);
    }

    public refresh(): void {
        this.nodesByPath.clear();
        this.internalOnDidChangeTreeData.fire();
    }

    public refreshProjectNode(rootPath: string): void {
        const node = this.nodesByPath.get(rootPath);
        if (!node) { return; }
        node.updateIcon();
        this.internalOnDidChangeTreeData.fire(node);
    }

    public handleDrag(source: readonly (ProjectNode | TagNode)[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
        const projectNodes = source.filter((s): s is ProjectNode => s instanceof ProjectNode);
        if (projectNodes.length === 0) { return; }

        const paths = projectNodes.map(n => n.preview.path);
        dataTransfer.set(StorageProvider.DRAG_MIME_TYPE, new vscode.DataTransferItem(paths));
    }

    public async handleDrop(target: ProjectNode | TagNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        if (!target || !(target instanceof ProjectNode)) { return; }

        const transferItem = dataTransfer.get(StorageProvider.DRAG_MIME_TYPE);
        if (!transferItem) { return; }

        const sourcePaths: string[] = transferItem.value;
        if (!sourcePaths || sourcePaths.length === 0) { return; }

        this.projectSource.moveProject(sourcePaths[ 0 ], target.preview.path);
        this.refresh();
    }

    public getTreeItem(element: ProjectNode | TagNode | InvestigationNode): vscode.TreeItem {
        // Clear the eager tooltip on project/investigation rows so VS Code calls
        // resolveTreeItem() and we can build the rich tooltip lazily on hover.
        if (element instanceof ProjectNode || element instanceof InvestigationNode) {
            element.tooltip = undefined;
        }
        return element;
    }

    public async resolveTreeItem(item: vscode.TreeItem, element: ProjectNode | TagNode | InvestigationNode, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
        if (element instanceof ProjectNode) {
            item.tooltip = await buildProjectTooltip(element.preview.path, element.label, false);
        } else if (element instanceof InvestigationNode) {
            item.tooltip = await buildProjectTooltip(element.rootPath, element.label, true);
        }
        return item;
    }

    public getChildren(element?: ProjectNode | TagNode): Thenable<(ProjectNode | TagNode | InvestigationNode)[]> {

        return new Promise(resolve => {

            if (element) {

                const nodes: (ProjectNode | InvestigationNode)[] = [];

                let projectsMapped = <ProjectInQuickPickList>this.projectSource.getProjectsByTag(element.label);

                if (projectsMapped.length === 0) {
                    resolve(nodes);
                }

                projectsMapped = sortProjects(projectsMapped);

                for (let index = 0; index < projectsMapped.length; index++) {
                    nodes.push(this.buildNode(projectsMapped[ index ]));
                }

                resolve(nodes);

            } else { // ROOT

                // no project saved yet
                if (this.projectSource.length() === 0) {
                    return resolve([]);
                }

                // choose the view
                const viewAsList = Container.context.globalState.get<boolean>("viewAsList", true);

                // viewAsTags - must have at least one tag otherwise, use `viewAsList`
                if (!viewAsList) {
                    let nodes: TagNode[] = [];

                    const tagsCollapseBehavior = vscode.workspace.getConfiguration("projectManager").get<string>("tags.collapseItems", "startExpanded");
                    const tags = this.projectSource.getAvailableTags().sort();
                    for (const tag of tags) {
                        nodes.push(new TagNode(tag, StorageProvider.getTagCollapsibleState(tag, tagsCollapseBehavior)));
                    }

                    // has any, then OK
                    if (nodes.length > 0) {
                        if (this.projectSource.getProjectsByTag('').length !== 0) {
                            nodes.push(new NoTagNode(NO_TAGS_DEFINED, StorageProvider.getTagCollapsibleState(NO_TAGS_DEFINED, tagsCollapseBehavior)));
                        }

                        // should filter ?
                        const filterByTags = Container.context.globalState.get<string[]>("filterByTags", []);
                        if (filterByTags.length > 0) {
                            nodes = nodes.filter(node => filterByTags.includes(node.label)
                                || (filterByTags.includes(NO_TAGS_DEFINED) && node.label === ""));
                        }

                        resolve(nodes);
                        return;
                    }
                }

                // viewAsList OR no Tags
                // raw list
                const nodes: (ProjectNode | InvestigationNode)[] = [];

                let projectsMapped: ProjectInQuickPickList;

                const filterByTags = Container.context.globalState.get<string[]>("filterByTags", []);
                if (filterByTags.length > 0) {
                    projectsMapped = <ProjectInQuickPickList>this.projectSource.getProjectsByTags(filterByTags);
                } else {
                    projectsMapped = <ProjectInQuickPickList>this.projectSource.map();
                }

                projectsMapped = sortProjects(projectsMapped);

                for (let index = 0; index < projectsMapped.length; index++) {
                    nodes.push(this.buildNode(projectsMapped[ index ]));
                }

                resolve(nodes);
            }
        });
    }

    /** Build the right node for a project entry — investigation (magnifying glass)
     *  vs normal project — based on its `kind`. */
    private buildNode(prj: ProjectInQuickPick): ProjectNode | InvestigationNode {
        const expandedPath = PathUtils.expandHomePath(prj.description);
        if (prj.kind === "investigation") {
            const invNode = new InvestigationNode(prj.label, expandedPath, prj.profile);
            // Register so the targeted poll refresh (refreshProjectNode) can update
            // its Claude status icon in place, same as a normal ProjectNode.
            this.nodesByPath.set(expandedPath, invNode);
            return invNode;
        }
        let iconFavorites = "favorites";
        if (path.extname(prj.description) === ".code-workspace") {
            iconFavorites = "favorites-workspace";
        } else if (isRemotePath(prj.description)) {
            iconFavorites = "favorites-remote";
        }
        const node = new ProjectNode(prj.label, vscode.TreeItemCollapsibleState.None,
            iconFavorites, {
                name: prj.label,
                path: expandedPath
            }, {
                command: "_projectManager.open",
                title: "",
                arguments: [ expandedPath, prj.label, prj.profile ],
            });
        this.nodesByPath.set(expandedPath, node);
        return node;
    }

}
