import type { MemoryItem } from './types.js';
/** 可注入的文件系统依赖：测试可替换为故障注入桩 */
export interface StoreFsStat {
    mtimeMs: number;
    size: number;
}
export interface StoreFileHandle {
    writeFile(body: string, encoding: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
}
export interface StoreFs {
    stat(path: string): Promise<StoreFsStat>;
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    mkdir(path: string, opts: {
        recursive: true;
    }): Promise<unknown>;
    writeFile(path: string, body: string, encoding: 'utf8'): Promise<void>;
    open(path: string, flags: string): Promise<StoreFileHandle>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
}
export interface StoreOptions {
    fs: StoreFs;
    dataDir: string;
    dataFile: string;
    defaultScope: string;
    /** 行级规范化缺失 id 时使用（M1 起启用） */
    makeId?: () => string;
    /** 行级规范化缺失时间戳时使用（M1 起启用） */
    now?: () => string;
    /** 启动告警等非致命诊断（B2 起启用） */
    onWarn?: (message: string) => void;
}
export interface MemoryStore {
    readItems(): Promise<MemoryItem[]>;
    writeItems(items: MemoryItem[]): Promise<void>;
    invalidateCache(): void;
}
/**
 * 记忆库读写实现（fs 可注入）。
 * 文件级缓存：stat（mtime+size）未变时复用解析结果，避免每轮 pre-step 重复读盘。
 */
export declare function createStore(opts: StoreOptions): MemoryStore;
