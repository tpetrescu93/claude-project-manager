/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Command, IconPath, MarkdownString, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import { ThemeIcons } from "vscode-ext-codicons";
import { currentIconThemeHasFolderIcon, getProjectIcon, getIconDetailsFromProjectPath } from "../utils/icons";
import { REMOTE_PREFIX, VIRTUAL_WORKSPACE_PREFIX } from "../utils/remote";
import { getPrStatusForPath, PrStatus } from "../commands/projectStatuses";
import { Container } from "../core/container";

export interface ProjectPreview {
    name: string;
    path: string;
    detail?: string;
}

export class ProjectNode extends TreeItem {

    constructor(
        public readonly label: string,
        public readonly collapsibleState: TreeItemCollapsibleState,
        public readonly icon: string | undefined,
        public readonly preview: ProjectPreview,
        public readonly command?: Command
    ) {
        super(label, collapsibleState);

        if (icon) {
            const prStatus = getPrStatusForPath(preview.path);
            const prIcon = ProjectNode.getPrStatusIcon(prStatus);
            this.iconPath = prIcon ?? this.getIconPath(icon, preview.path);
            this.contextValue = "ProjectNodeKind";
        } else {
            this.contextValue = "ConfigNodeKind";
        }

        this.resourceUri = Uri.from({
            scheme: 'projectManager-view',
            path: preview.path
        });

        const tooltipIcon = getIconDetailsFromProjectPath(preview.path);
        this.tooltip = new MarkdownString(
            `${label}\n\n_${preview.path}_\n\n${tooltipIcon.icon} ${tooltipIcon.title}`, true);
        this.description = preview.detail;
    }

    private static getPrStatusIcon(status: PrStatus): IconPath | undefined {
        switch (status) {
            case "no_pr":
                return new ThemeIcon("circle-outline");
            case "open_pending":
                return new ThemeIcon("sync~spin", new ThemeColor("charts.yellow"));
            case "open_passing":
                return new ThemeIcon("pass-filled", new ThemeColor("charts.green"));
            case "open_failing":
                return {
                    light: Uri.joinPath(Container.context.extensionUri, "images/ico-status-failing-light.svg"),
                    dark: Uri.joinPath(Container.context.extensionUri, "images/ico-status-failing-dark.svg")
                };
            case "merged":
                return {
                    light: Uri.joinPath(Container.context.extensionUri, "images/ico-status-merged-light.svg"),
                    dark: Uri.joinPath(Container.context.extensionUri, "images/ico-status-merged-dark.svg")
                };
            default:
                return undefined;
        }
    }

    private getIconPath(icon: string, projectPath: string): string | IconPath {
        if (currentIconThemeHasFolderIcon()) {
            return getProjectIcon(icon, projectPath);
        } else {
            // if icon is a string that matches the pattern $(icon-name), returns corresponding ThemeIcon
            if (/^\$\([a-z-]+\)$/.test(icon)) {
                return new ThemeIcon(icon.substring(2, icon.length - 1));
            }
            switch (icon) {
                case "Git":
                case "Mercurial":
                    return ThemeIcons.git_merge;

                case "SVN":
                    return ThemeIcons.zap;

                case "VSCode":
                    return ThemeIcons.file_code;

                case "Any":
                    return ThemeIcons.folder;

                case "favorites":
                    return ThemeIcons.folder;

                case "favorites-workspace":
                    return ThemeIcons.root_folder;

                case "favorites-remote":
                    if (projectPath.startsWith(`${REMOTE_PREFIX}://codespaces`)) {
                        return ThemeIcons.github;
                    }
                    if (projectPath.startsWith(`${REMOTE_PREFIX}://dev-container`)) {
                        return new ThemeIcon('symbol-method', new ThemeColor("icon.foreground"));
                    }
                    if (projectPath.startsWith(`${REMOTE_PREFIX}://ssh`)) {
                        return ThemeIcons.terminal;
                    }
                    if (projectPath.startsWith(`${REMOTE_PREFIX}://wsl`)) {
                        return ThemeIcons.terminal_linux;
                    }
                    if (projectPath.startsWith(`${VIRTUAL_WORKSPACE_PREFIX}://`)) {
                        return ThemeIcons.remote;
                    }
                    return ThemeIcons.remote_explorer;

                default:
                    return getProjectIcon(icon, projectPath);
            }
        }
    }

}


export class ArchivedProjectNode extends TreeItem {

    constructor(
        public readonly label: string,
        public readonly collapsibleState: TreeItemCollapsibleState,
        public readonly preview: ProjectPreview,
        public readonly command?: Command
    ) {
        super(label, collapsibleState);
        this.contextValue = "ArchivedProjectNodeKind";
        this.iconPath = ThemeIcons.folder;
        this.resourceUri = Uri.from({
            scheme: 'projectManager-view',
            path: preview.path
        });
        this.description = preview.detail;
    }
}

export class TagNode extends TreeItem {

    constructor(
        public readonly label: string,
        public readonly collapsibleState: TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
        this.iconPath = ThemeIcons.tag;
    }
}

export class NoTagNode extends TagNode {

    constructor(
        label: string,
        public readonly collapsibleState: TreeItemCollapsibleState,
    ) {
        super("", collapsibleState);
        this.description = label;
    }
}
