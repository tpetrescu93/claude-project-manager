/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { Locators } from "../autodetect/locators";
import { ProjectStorage } from "../storage/storage";
import { ProjectNode, TagNode, InvestigationNode } from "./nodes";
import { AutodetectProvider, deduplicateByRemote } from "./autodetectProvider";
import { ArchivedProvider } from "./archivedProvider";
import { StorageProvider } from "./storageProvider";
import { Container } from "../core/container";
import { getPrMetaForPath } from "../commands/projectStatuses";
import { l10n } from "vscode";

export class Providers {

    public storageProvider: StorageProvider;
    public archivedProvider: ArchivedProvider;
    public vscodeProvider: AutodetectProvider;
    public gitProvider: AutodetectProvider;
    public mercurialProvider: AutodetectProvider;
    public svnProvider: AutodetectProvider;
    public anyProvider: AutodetectProvider;

    private storageTreeView: vscode.TreeView<ProjectNode | TagNode | InvestigationNode>;
    private archivedTreeView: vscode.TreeView<any>;
    private vscodeTreeView: vscode.TreeView<ProjectNode>;
    private gitTreeView: vscode.TreeView<ProjectNode>;
    private mercurialTreeView: vscode.TreeView<ProjectNode>;
    private svnTreeView: vscode.TreeView<ProjectNode>;
    private anyTreeView: vscode.TreeView<ProjectNode>;

    private locators: Locators;
    private projectStorage: ProjectStorage;

    constructor(locators: Locators, storage: ProjectStorage) {
        this.locators = locators;
        this.projectStorage = storage;

        this.storageProvider = new StorageProvider(this.projectStorage);
        this.archivedProvider = new ArchivedProvider(this.projectStorage);
        this.vscodeProvider = new AutodetectProvider(this.locators.vscLocator);
        this.gitProvider = new AutodetectProvider(this.locators.gitLocator);
        this.mercurialProvider = new AutodetectProvider(this.locators.mercurialLocator);
        this.svnProvider = new AutodetectProvider(this.locators.svnLocator);
        this.anyProvider = new AutodetectProvider(this.locators.anyLocator);

        this.storageTreeView = vscode.window.createTreeView("projectsExplorerFavorites", {
            treeDataProvider: this.storageProvider,
            dragAndDropController: this.storageProvider,
            showCollapseAll: true
        });
        this.archivedTreeView = vscode.window.createTreeView("projectsExplorerArchived", {
            treeDataProvider: this.archivedProvider,
            showCollapseAll: false
        });

        Container.context.subscriptions.push(
            vscode.commands.registerCommand("_projectManager.searchArchived", () => this.archivedProvider.search()),
        );
        this.vscodeTreeView = vscode.window.createTreeView("projectsExplorerVSCode", {
            treeDataProvider: this.vscodeProvider,
            showCollapseAll: false
        });
        this.gitTreeView = vscode.window.createTreeView("projectsExplorerGit", {
            treeDataProvider: this.gitProvider,
            dragAndDropController: this.gitProvider,
            showCollapseAll: false
        });
        this.mercurialTreeView = vscode.window.createTreeView("projectsExplorerMercurial", {
            treeDataProvider: this.mercurialProvider,
            showCollapseAll: false
        });
        this.svnTreeView = vscode.window.createTreeView("projectsExplorerSVN", {
            treeDataProvider: this.svnProvider,
            showCollapseAll: false
        });
        this.anyTreeView = vscode.window.createTreeView("projectsExplorerAny", {
            treeDataProvider: this.anyProvider,
            showCollapseAll: false
        });

        this.registerStorageTreeViewListeners();
    }

    private registerStorageTreeViewListeners() {
        Container.context.subscriptions.push(
            this.storageTreeView.onDidExpandElement(async event => {
                await this.handleStorageTreeViewExpansionChange(event, "expanded");
            }),
            this.storageTreeView.onDidCollapseElement(async event => {
                await this.handleStorageTreeViewExpansionChange(event, "collapsed");
            })
        );
    }

    private async handleStorageTreeViewExpansionChange(event: vscode.TreeViewExpansionEvent<ProjectNode | TagNode | InvestigationNode>, state: "expanded" | "collapsed") {
        const element = event.element;
        if (element instanceof TagNode) {
            const behavior = vscode.workspace.getConfiguration("projectManager").get<string>("tags.collapseItems", "startExpanded");
            const shouldPersistExpansion = behavior === "startExpanded" || behavior === "startCollapsed";
            if (shouldPersistExpansion) {
                const tagId = (element.label as string) || (element.description as string) || "";
                await StorageProvider.setTagExpanded(tagId, state === "expanded");
            }
        }
    }

    public async showTreeViewFromAllProviders() {
        // this.projectProviderStorage.showTreeView();
        await this.vscodeProvider.showTreeView();
        await this.gitProvider.showTreeView();
        await this.mercurialProvider.showTreeView();
        await this.svnProvider.showTreeView();
        await this.anyProvider.showTreeView();

        this.updateTreeViewDetails();
    }

    public refreshTreeViews() {
        this.storageProvider.refresh();
        this.vscodeProvider.refresh();
        this.gitProvider.refresh();
        this.mercurialProvider.refresh();
        this.svnProvider.refresh();
        this.anyProvider.refresh();
    }

    public refreshStorageTreeView() {
        this.storageProvider.refresh();
        this.archivedProvider.refresh();
        this.updateTreeViewStorage();
        this.updateArchivedVisibility();
    }

    public refreshStorageProjectNode(rootPath: string) {
        this.storageProvider.refreshProjectNode(rootPath);
    }

    public refreshInvestigations() {
        // Investigations render inside the Projects (storage) view now.
        this.storageProvider.refresh();
    }

    public updateTreeViewStorage() {
        const disabledProjects = this.projectStorage.disabled()?.length;
        this.storageTreeView.title = `Projects (${this.projectStorage.length() - disabledProjects})`;
        this.storageTreeView.description = "";
    }

    public updateArchivedVisibility() {
        const disabled = this.projectStorage.disabled() || [];
        const disabledCount = disabled.length;
        vscode.commands.executeCommand("setContext", "projectManager.canShowTreeViewArchived", disabledCount > 0);
        if (disabledCount > 0) {
            this.archivedTreeView.title = `Archived (${disabledCount})`;
            let totalAdditions = 0, totalDeletions = 0, totalFiles = 0;
            for (const p of disabled) {
                const meta = getPrMetaForPath(p.rootPath);
                if (meta) {
                    totalAdditions += meta.additions;
                    totalDeletions += meta.deletions;
                    totalFiles += meta.changedFiles;
                }
            }
            const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
            this.archivedTreeView.title = `Archived (${disabledCount})`;
            this.archivedTreeView.description = (totalAdditions > 0 || totalDeletions > 0)
                ? `+${fmt(totalAdditions)} -${fmt(totalDeletions)}`
                : "";
        }
    }

    public updateTreeViewDetails() {
        this.updateTreeViewStorage();
        this.updateArchivedVisibility();
        this.vscodeTreeView.title = `VSCode (${this.locators.vscLocator.projectList.length})`;
        this.gitTreeView.title = `Git (${deduplicateByRemote(this.locators.gitLocator.projectList).length})`;
        this.mercurialTreeView.title = `Mercurial (${this.locators.mercurialLocator.projectList.length})`;
        this.svnTreeView.title = `SVN (${this.locators.svnLocator.projectList.length})`;
        this.anyTreeView.title = `Any (${this.locators.anyLocator.projectList.length})`;
    }
}
