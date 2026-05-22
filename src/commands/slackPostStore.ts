/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Container } from "../core/container";

const KEY = "slackPostsByRootPath";

type Store = Record<string, string>;

function load(): Store {
    return Container.context.globalState.get<Store>(KEY, {});
}

function save(store: Store): void {
    Container.context.globalState.update(KEY, store);
}

export function setSlackPost(rootPath: string, permalink: string): void {
    const store = load();
    store[ rootPath ] = permalink;
    save(store);
}

export function getSlackPost(rootPath: string): string | undefined {
    return load()[ rootPath ];
}

export function deleteSlackPost(rootPath: string): void {
    const store = load();
    if (rootPath in store) {
        delete store[ rootPath ];
        save(store);
    }
}
