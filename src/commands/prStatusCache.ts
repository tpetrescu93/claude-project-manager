import { EventEmitter } from "vscode";
import { Container } from "../core/container";
import { PrStatus, PrMeta } from "./prStatusTypes";
const STATUS_CACHE_KEY = "projectStatuses.statusCache";
const PR_URL_CACHE_KEY = "projectStatuses.prUrlCache";
const PR_META_CACHE_KEY = "projectStatuses.prMetaCache";

export const statusCache = new Map<string, PrStatus>();
export const prUrlCache = new Map<string, string>();
export const prMetaCache = new Map<string, PrMeta>();

export const statusChangeEmitter = new EventEmitter<void>();
export const onStatusChange = statusChangeEmitter.event;

export function loadCachesFromGlobalState(): void {
    const status = Container.context.globalState.get<Record<string, PrStatus>>(STATUS_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(status)) {
        statusCache.set(rootPath, value);
    }
    const urls = Container.context.globalState.get<Record<string, string>>(PR_URL_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(urls)) {
        prUrlCache.set(rootPath, value);
    }
    const meta = Container.context.globalState.get<Record<string, PrMeta>>(PR_META_CACHE_KEY, {});
    for (const [ rootPath, value ] of Object.entries(meta)) {
        prMetaCache.set(rootPath, value);
    }
}

export function persistCachesToGlobalState(): void {
    const status: Record<string, PrStatus> = {};
    for (const [ k, v ] of statusCache) { status[ k ] = v; }
    const urls: Record<string, string> = {};
    for (const [ k, v ] of prUrlCache) { urls[ k ] = v; }
    const meta: Record<string, PrMeta> = {};
    for (const [ k, v ] of prMetaCache) { meta[ k ] = v; }
    Container.context.globalState.update(STATUS_CACHE_KEY, status);
    Container.context.globalState.update(PR_URL_CACHE_KEY, urls);
    Container.context.globalState.update(PR_META_CACHE_KEY, meta);
}

export function getPrStatusForPath(rootPath: string): PrStatus {
    return statusCache.get(rootPath) ?? null;
}

export function getPrUrlForPath(rootPath: string): string | undefined {
    return prUrlCache.get(rootPath);
}

export function getPrMetaForPath(rootPath: string): PrMeta | undefined {
    return prMetaCache.get(rootPath);
}

