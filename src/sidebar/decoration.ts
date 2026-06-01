/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { ThemeColor, window, workspace } from 'vscode';
import { Container } from '../core/container';

export function registerSideBarDecorations() {
    window.registerFileDecorationProvider({
        provideFileDecoration: (uri) => {
            if (uri.scheme !== 'projectManager-view') { return undefined; }
            // Highlight the row for the active workspace. For known projects that's
            // Container.currentProject; for investigations (scratch dirs not in
            // storage/locators, so currentProject is undefined) fall back to the
            // active workspace folder path.
            const currentPath = Container.currentProject?.rootPath;
            const activePath = workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (uri.path === currentPath || uri.path === activePath) {
                return {
                    color: new ThemeColor('projectManager.sideBar.currentProjectHighlightForeground')
                };
            }
            return undefined;
        }
    });
}
