/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { ThemeColor, window } from 'vscode';
import { Container } from '../core/container';
import { isGitRepoPinned, onDidPinChange } from '../commands/gitPinning';

export function registerSideBarDecorations() {
    window.registerFileDecorationProvider({
        onDidChangeFileDecorations: onDidPinChange,
        provideFileDecoration: (uri) => {
            if (uri.scheme === 'projectManager-view') {
                if (uri.path === Container.currentProject.rootPath) {
                    return {
                        color: new ThemeColor('projectManager.sideBar.currentProjectHighlightForeground')
                    };
                }
                return undefined;
            }

            if (uri.scheme === 'projectManager-readonly-view') {
                if (isGitRepoPinned(uri.path)) {
                    return {
                        badge: '📌',
                        tooltip: 'Pinned'
                    };
                }
                return undefined;
            }

            return undefined;
        }
    });
}
