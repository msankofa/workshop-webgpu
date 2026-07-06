export function openHandleDb(dbName, storeName = 'handles') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(storeName);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getStoredHandle(dbName, storeName, key) {
  try {
    const db = await openHandleDb(dbName, storeName);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveStoredHandle(dbName, storeName, key, handle) {
  try {
    const db = await openHandleDb(dbName, storeName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Persistent FileSystemHandle storage is optional.
  }
}

export function createHandleStore(dbName, storeName = 'handles') {
  return {
    open: () => openHandleDb(dbName, storeName),
    get: key => getStoredHandle(dbName, storeName, key),
    save: (key, handle) => saveStoredHandle(dbName, storeName, key, handle)
  };
}

export async function hasReadWritePermission(handle) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return await handle.requestPermission(opts) === 'granted';
}
