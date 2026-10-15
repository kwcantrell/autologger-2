onmessage = async () => {
  const r = {}; let step = 'getDirectory';
  try {
    const root = await navigator.storage.getDirectory();
    step = 'getDirectoryHandle'; const dir = await root.getDirectoryHandle('spike', { create: true });
    step = 'getFileHandle'; const fh = await dir.getFileHandle('chunk.bin', { create: true });
    r.hasCreateSyncAccessHandle = typeof fh.createSyncAccessHandle === 'function';
    step = 'createSyncAccessHandle'; const h = await fh.createSyncAccessHandle(); step = 'write/read';
    const data = new Uint8Array(100000).map((_, i) => i & 255);
    h.truncate(0); let w = h.write(data, { at: 0 }); w += h.write(data.subarray(0, 5000), { at: h.getSize() }); h.flush();
    const size = h.getSize(); const back = new Uint8Array(size); const rd = h.read(back, { at: 0 }); h.close();
    let ok = rd === 105000; for (let i = 0; ok && i < 100000; i++) ok = back[i] === (i & 255);
    const file = await fh.getFile();
    r.opfs = { written: w, size, read: rd, bytesMatch: ok, getFileSize: file.size };
    await dir.removeEntry('chunk.bin');
  } catch (e) { r.opfsError = step + ': ' + String(e && (e.name + ': ' + e.message)); }
  postMessage(r);
};
