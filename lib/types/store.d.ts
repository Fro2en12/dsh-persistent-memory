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
    open(path: string, flags: string): Promise<StoreFileHandle>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
    /** 清理 tmp 残留与释放写锁（必填：缺失会导致锁泄漏） */
    unlink(path: string): Promise<void>;
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
    /** 启动告警等非致命诊断 */
    onWarn?: (message: string) => void;
}
/** 乐观并发冲突：磁盘版本已不是本实例读到的那一版（B3 跨进程保护） */
export declare class StoreConflictError extends Error {
    readonly code = "MEMORY_STORE_CONFLICT";
    constructor(message: string);
}
/**
 * B3：冲突重试助手。fn 内必须是「读 → 改 → 写」的完整序列——
 * writeItems 失败会失效缓存，重试时 readItems 会重新读盘，绝不基于旧快照重写。
 */
export declare function withConflictRetry<T>(fn: () => Promise<T>, attempts?: number): Promise<T>;
export interface MemoryStore {
    readItems(): Promise<MemoryItem[]>;
    writeItems(items: MemoryItem[]): Promise<void>;
    invalidateCache(): void;
    /** 最近一次读盘时被丢弃的坏行数（M1） */
    getDropped(): number;
}
/**
 * 记忆库读写实现（fs 可注入）。
 * 文件级缓存：stat（mtime+size）未变时复用解析结果，避免每轮 pre-step 重复读盘。
 *
 * B2（原子写）：tmp + fsync + rename——磁盘满/崩溃时主文件保持上一版完整内容；
 * 写前复制 memory.jsonl.bak 保留 1 份上一版快照；启动时主文件 0 字节 + .bak 非空 → 告警。
 * C1（缓存一致性）：readItems 返回副本，杜绝外部就地改写缓存；writeItems 失败必失效，
 * 成功后才刷新缓存。
 */
export declare function createStore(opts: StoreOptions): MemoryStore;
