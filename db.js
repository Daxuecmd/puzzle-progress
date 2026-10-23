// 本机存储：IndexedDB 里三张表——记录、文件（图片 / 录音）、杂项
const NAME = 'puzzle-progress';
let opening;

function open() {
  return (opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('records', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const allRecords = () => run('records', 'readonly', s => s.getAll());
export const putRecord = rec => run('records', 'readwrite', s => s.put(rec));
export const putRecords = recs => run('records', 'readwrite', s => { recs.forEach(r => s.put(r)); });

export const getFile = id => run('files', 'readonly', s => s.get(id));
export const putFile = f => run('files', 'readwrite', s => s.put(f));
export const allFiles = () => run('files', 'readonly', s => s.getAll());

export async function clearAll() {
  await run('records', 'readwrite', s => s.clear());
  await run('files', 'readwrite', s => s.clear());
}
