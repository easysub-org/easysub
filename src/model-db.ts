// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 翻译模型文件的本地存储：用户用 <input type=file> 选目录读入的文件统一落 IndexedDB，
// popup 写入、offscreen 翻译 worker 读取，扩展各上下文同源共享，无需任何权限。
const DB_NAME = 'tmspeech';
const DB_VERSION = 1;
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });
}

// 键 = 相对路径（webkitRelativePath），如 `opus-mt-en-zh/config.json`
export async function saveModelFile(key: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, key);
    await txDone(tx);
  } finally {
    db.close();
  }
}

// 直接存 File/Blob（IndexedDB 原生支持）：ASR 模型 412MB，避免 arrayBuffer() 拷贝一份内存
export async function saveModelBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    await txDone(tx);
  } finally {
    db.close();
  }
}

// 原子批量写：可选地先删匹配旧键、再写入整批新键，全部放进**同一个读写事务**。
// IndexedDB 事务是原子的——中途失败/页面关闭整体回滚，不会出现"旧模型已删、
// 新模型只写一半"的半套损坏状态（旧实现先删后逐文件写，写一半断掉即损坏）。
// 注意：键清单先在只读事务里算好再开写事务，避免读写事务内跨 await（兼容性最稳）。
export async function saveModelFilesAtomic(
  entries: { key: string; data: ArrayBuffer | Blob }[],
  deleteMatch?: (key: string) => boolean,
): Promise<void> {
  const doomed = deleteMatch ? (await listModelKeys()).filter(deleteMatch) : [];
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const key of doomed) store.delete(key);
    for (const { key, data } of entries) store.put(data, key);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function getModelFile(key: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
    });
    if (raw == null) return null;
    return raw instanceof Blob ? raw : new Blob([raw as ArrayBuffer]);
  } finally {
    db.close();
  }
}

export async function listModelKeys(): Promise<string[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 读取失败'));
    });
    return (keys as string[]) || [];
  } finally {
    db.close();
  }
}

export async function clearModels(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } finally {
    db.close();
  }
}

// 定向清理：只删匹配的键。翻译模型重传走这里（只删 opus-mt*），
// 否则 clear() 会把 ASR 模型（__asr_wasm_data）一起清掉，用户就得重新导入 412MB
export async function deleteModelKeys(match: (key: string) => boolean): Promise<void> {
  const keys = await listModelKeys();
  const doomed = keys.filter(match);
  if (doomed.length === 0) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const key of doomed) store.delete(key);
    await txDone(tx);
  } finally {
    db.close();
  }
}
