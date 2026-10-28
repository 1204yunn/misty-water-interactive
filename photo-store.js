export const PHOTO_DB = 'MistyWaterLabPhotos';
export const PHOTO_STORE = 'photos';

function openPhotos() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('照片資料庫被其他分頁占用，請關閉舊分頁後重試。'));
  });
}

async function transact(mode, action) {
  const db = await openPhotos();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PHOTO_STORE, mode);
    const request = action(transaction.objectStore(PHOTO_STORE));
    transaction.oncomplete = () => { const value=request.result; db.close(); resolve(value); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error || request.error); };
  });
}

export async function savePhoto({ blob, width, height }, id = crypto.randomUUID()) {
  const record = { id, blob, width, height, mime: blob.type, createdAt: new Date().toISOString() };
  await transact('readwrite', store => store.put(record));
  return record;
}

// Same-origin mobile.html can import this or use the documented DB schema.
export const loadPhoto = id => transact('readonly', store => store.get(id));
