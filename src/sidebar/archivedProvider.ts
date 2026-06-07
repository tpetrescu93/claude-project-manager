import * as vscode from "vscode";
import { ProjectStorage } from "../storage/storage";
import { PathUtils } from "../utils/path";
import { ArchivedProjectNode } from "./nodes";
import { buildProjectTooltip } from "../commands/projectTooltip";

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

    public async search(): Promise<void> {
        const disabled = this.projectSource.disabled() || [];
        if (disabled.length === 0) { return; }

        interface ArchivedItem extends vscode.QuickPickItem {
            rootPath: string;
            projectName: string;
        }

        const items: ArchivedItem[] = disabled.map(p => {
            const displayLabel = p.repoName ? `${p.repoName} · ${p.name}` : p.name;
            return {
                label: displayLabel,
                description: PathUtils.expandHomePath(p.rootPath),
                rootPath: PathUtils.expandHomePath(p.rootPath),
                projectName: p.name,
            };
        });

        const pick = vscode.window.createQuickPick<ArchivedItem>();
        pick.placeholder = "Pick an archived project to open…";
        pick.matchOnDescription = true;
        pick.items = items;

        pick.onDidAccept(() => {
            const selected = pick.selectedItems[0];
            if (selected) {
                vscode.commands.executeCommand("_projectManager.open", selected.rootPath, selected.projectName);
            }
            pick.hide();
        });

        pick.onDidHide(() => pick.dispose());
        pick.show();
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
        const nodes = disabled.map(p => {
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
