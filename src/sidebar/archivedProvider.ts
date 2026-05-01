/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { ProjectStorage } from "../storage/storage";
import { PathUtils } from "../utils/path";
import { ArchivedProjectNode } from "./nodes";

export class ArchivedProvider implements vscode.TreeDataProvider<ArchivedProjectNode> {

    public readonly onDidChangeTreeData: vscode.Event<ArchivedProjectNode | void>;

    private projectSource: ProjectStorage;
    private internalOnDidChangeTreeData: vscode.EventEmitter<ArchivedProjectNode | void> = new vscode.EventEmitter<ArchivedProjectNode | void>();

    constructor(projectSource: ProjectStorage) {
        this.projectSource = projectSource;
        this.onDidChangeTreeData = this.internalOnDidChangeTreeData.event;
    }

    public refresh(): void {
        this.internalOnDidChangeTreeData.fire();
    }

    public getTreeItem(element: ArchivedProjectNode): vscode.TreeItem {
        return element;
    }

    public getChildren(): Thenable<ArchivedProjectNode[]> {
        const disabled = this.projectSource.disabled() || [];
        const nodes = disabled.map(p =>
            new ArchivedProjectNode(p.name, vscode.TreeItemCollapsibleState.None, {
                name: p.name,
                path: PathUtils.expandHomePath(p.rootPath)
            })
        );
        return Promise.resolve(nodes);
    }
}
