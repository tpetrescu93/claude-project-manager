import * as vscode from "vscode";
import { ProjectStorage } from "../storage/storage";
import { PathUtils } from "../utils/path";
import { ArchivedProjectNode } from "./nodes";
import { buildProjectTooltip } from "../commands/projectTooltip";

export class ArchivedProvider implements vscode.TreeDataProvider<ArchivedProjectNode>, vscode.TreeDragAndDropController<ArchivedProjectNode> {

    private static readonly DRAG_MIME_TYPE = "application/vnd.code.tree.projectsExplorerArchived";

    public readonly dropMimeTypes: readonly string[] = [ ArchivedProvider.DRAG_MIME_TYPE ];
    public readonly dragMimeTypes: readonly string[] = [ ArchivedProvider.DRAG_MIME_TYPE ];

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

    public handleDrag(source: readonly ArchivedProjectNode[], dataTransfer: vscode.DataTransfer): void {
        if (source.length === 0) { return; }
        dataTransfer.set(ArchivedProvider.DRAG_MIME_TYPE,
            new vscode.DataTransferItem(source.map(n => n.preview.path)));
    }

    public async handleDrop(target: ArchivedProjectNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        if (!target) { return; }
        const transferItem = dataTransfer.get(ArchivedProvider.DRAG_MIME_TYPE);
        if (!transferItem) { return; }
        const sourcePaths: string[] = transferItem.value;
        if (!sourcePaths || sourcePaths.length === 0) { return; }

        // moveProject reorders the global projects array by rootPath; the archived
        // view is a filtered slice of it, so this reorders archived rows directly.
        this.projectSource.moveProject(sourcePaths[ 0 ], target.preview.path);
        this.refresh();
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
