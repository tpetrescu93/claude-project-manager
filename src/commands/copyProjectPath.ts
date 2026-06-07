/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { commands, env, l10n, window } from "vscode";
import { Container } from "../core/container";
import { ProjectNode } from "../sidebar/nodes";

async function copyProjectPath(node: ProjectNode) {
    if (!node) { return; }
    const projectPath: string = node.command.arguments[ 0 ];
    await env.clipboard.writeText(projectPath);
    window.showInformationMessage(l10n.t("Path copied to clipboard"));
}

export function registerCopyProjectPath() {
    Container.context.subscriptions.push(
        commands.registerCommand("_projectManager.copyProjectPath", (node) => copyProjectPath(node))
    );
}
