/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

export const PROJECTS_FILE = "projects.json";

import * as os from "os";
import * as path from "path";

/** Where working copies (clones/forks/investigations) live. */
export const PROJECTS_BASE = path.join(os.homedir(), "projects");

/** Where canonical git repos live — a hidden `.repos` folder under the projects base. */
export const REPOS_BASE = path.join(PROJECTS_BASE, ".repos");

export enum CommandLocation { CommandPalette, SideBar, StatusBar }

export enum OpenInCurrentWindowIfEmptyMode {
    always = "always",
    onlyUsingCommandPalette = "onlyUsingCommandPalette",
    onlyUsingSideBar = "onlyUsingSideBar",
    never = "never"
}

export enum ConfirmSwitchOnActiveWindowMode {
    never = "never",
    onlyUsingCommandPalette = "onlyUsingCommandPalette",
    onlyUsingSideBar = "onlyUsingSideBar",
    always = "always"
}