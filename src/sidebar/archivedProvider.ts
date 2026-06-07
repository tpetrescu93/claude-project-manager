import * as vscode from "vscode";
import { ProjectStorage } from "../storage/storage";
import { PathUtils } from "../utils/path";
import { ArchivedProjectNode } from "./nodes";
import { buildProjectTooltip } from "../commands/projectTooltip";

export class ArchivedProvider implements vscode.TreeDataProvider<ArchivedProjectNode> {

    public readonly onDidChangeTreeData: vscode.Event<ArchivedProjectNode | void>;

    private projectSource: ProjectStorage;
    private internalOnDidChangeTreeData: vscode.EventEmitter<ArchivedProjectNode | void> = new vscode.EventEmitter<ArchivedProjectNode | void>();
    private filterQuery = "";

    constructor(projectSource: ProjectStorage) {
        this.projectSource = projectSource;
        this.onDidChangeTreeData = this.internalOnDidChangeTreeData.event;
    }

    public refresh(): void {
        this.internalOnDidChangeTreeData.fire();
    }

    public async search(): Promise<void> {
        const query = await vscode.window.showInputBox({
            prompt: "Filter archived projects",
            placeHolder: "Type to filter…",
            value: this.filterQuery,
        });
        if (query === undefined) { return; } // cancelled
        this.filterQuery = query.trim().toLowerCase();
        vscode.commands.executeCommand("setContext", "projectManager.archivedFiltered", this.isFiltered);
        this.refresh();
    }

    public clearSearch(): void {
        this.filterQuery = "";
        vscode.commands.executeCommand("setContext", "projectManager.archivedFiltered", false);
        this.refresh();
    }

    public get isFiltered(): boolean {
        return this.filterQuery.length > 0;
    }

    public getTreeItem(element: ArchivedProjectNode): vscode.TreeItem {
        element.tooltip = undefined; // cleared so resolveTreeItem is called lazily
        return element;
    }

    public async resolveTreeItem(item: vscode.TreeItem, element: ArchivedProjectNode): Promise<vscode.TreeItem> {
        item.tooltip = await buildProjectTooltip(element.preview.path, element.preview.name, false);
        return item;
    }

    public getChildren(): Thenable<ArchivedProjectNode[]> {
        const disabled = this.projectSource.disabled() || [];
        const nodes = disabled
            .filter(p => {
                if (!this.filterQuery) { return true; }
                const displayLabel = p.repoName ? `${p.repoName} · ${p.name}` : p.name;
                return displayLabel.toLowerCase().includes(this.filterQuery);
            })
            .map(p => {
                const path = PathUtils.expandHomePath(p.rootPath);
                const displayLabel = p.repoName ? `${p.repoName} · ${p.name}` : p.name;
                return new ArchivedProjectNode(displayLabel, vscode.TreeItemCollapsibleState.None, {
                    name: p.name,
                    path
                }, {
                    command: "_projectManager.open",
                    title: "",
                    arguments: [ path, p.name ]
                });
            });
        return Promise.resolve(nodes);
    }
}
