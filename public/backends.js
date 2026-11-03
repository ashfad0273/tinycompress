'use strict';

// The interface talks to one of these two. Local keeps keys and results on this computer
// through server.js. Cloud keeps them in the browser and reaches TinyPNG through a
// Cloudflare function. `/api/config` says which one is running.

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

function saveAs(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
}

function createLocalBackend() {
  // XHR because it reports upload progress and exposes the streamed response as it arrives.
  function send(url, file, { onEvent, onUpload }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let parsed = 0;
      let result = null;

      const readLines = () => {
        const text = xhr.responseText;
        for (;;) {
          const end = text.indexOf('\n', parsed);
          if (end < 0) return;
          const line = text.slice(parsed, end);
          parsed = end + 1;
          const event = JSON.parse(line);
          if (event.stage === 'result') result = event;
          else onEvent(event);
        }
      };

      xhr.open('POST', url);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onUpload(event.loaded / event.total);
      };
      xhr.onprogress = () => {
        if (xhr.status === 200) readLines();
      };
      xhr.onload = () => {
        if (xhr.status !== 200) {
          let message = `Server error ${xhr.status}`;
          try {
            message = JSON.parse(xhr.responseText).message || message;
          } catch {
            // Keep the status message.
          }
          resolve({ ok: false, code: 'error', message });
          return;
        }
        readLines();
        resolve(result || { ok: false, code: 'error', message: 'The server stopped responding' });
      };
      xhr.onerror = () => reject(new Error('Could not reach the local server or read this file'));
      xhr.send(file);
    });
  }

  return {
    mode: 'local',
    canOpenFolder: true,
    canPickFolder: false,
    privacyText: 'Runs on this computer. Images go only to the TinyPNG API.',

    listKeys: async () => (await requestJson('/api/keys')).body.keys,
    addKeys: async (raw) => (await requestJson('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: raw }),
    })).body,
    removeKey: async (id) => (await requestJson(`/api/keys/${id}`, { method: 'DELETE' })).body.keys,
    checkKeys: async () => (await requestJson('/api/keys/check', { method: 'POST' })).body.keys,

    async createBatch() {
      const { body } = await requestJson('/api/batches', { method: 'POST' });
      return { id: body.id, label: `Saving to ${body.dir}`, title: body.dir };
    },
    compress(file, { batch, path, formats }, callbacks) {
      const params = new URLSearchParams({ batch, path, formats: formats.join(',') });
      return send(`/api/compress?${params}`, file, callbacks);
    },
    outputUrl: async (batch, path) => `/api/file?${new URLSearchParams({ batch, path })}`,
    downloadZip: async (batch) => saveAs(`/api/batches/${batch}/zip`, ''),
    openFolder: (batch) => requestJson(`/api/batches/${batch}/open`, { method: 'POST' }),
    hasUnsaved: () => false,
    reset() {},
  };
}

function createCloudBackend(defaultKeyCount) {
  const { KeyRing, NoKeysError, OutputPlanner, TinifyClient, TinifyError, ZipWriter } = TinyCore;
  const { batchId, crc32, describeOutput, safeSegments } = TinyCore;
  const STORAGE_KEY = 'tinycompress.keys';

  class BrowserKeyRing extends KeyRing {
    constructor() {
      let keys = [];
      try {
        keys = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
      } catch {
        // Storage is blocked or damaged, so keys last only as long as this tab.
      }
      const defaults = Array.from({ length: defaultKeyCount }, (_, i) => ({
        id: `default-${i}`,
        key: String(i),
        label: `Default ${i + 1}`,
        shared: true,
        status: 'active',
        count: 0,
        note: '',
      }));
      super([...keys, ...defaults]);
    }

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.keys.filter((k) => !k.shared)));
      } catch {
        // Same as above.
      }
    }
  }

  const keys = new BrowserKeyRing();
  const tinify = new TinifyClient({ baseUrl: '/api/tinify', keys });
  let root = null; // The folder the visitor picked, if any.
  let current = null;

  async function writeToFolder(dir, segments, data) {
    let folder = dir;
    for (const segment of segments.slice(0, -1)) {
      folder = await folder.getDirectoryHandle(segment, { create: true });
    }
    const handle = await folder.getFileHandle(segments.at(-1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return handle;
  }

  const blobOf = (saved) => saved.blob || saved.handle.getFile();

  return {
    mode: 'cloud',
    canOpenFolder: false,
    canPickFolder: 'showDirectoryPicker' in window,
    privacyText: 'Keys you add stay in this browser. Images pass through Cloudflare to the TinyPNG API and are not stored.',

    listKeys: async () => keys.list(),
    async addKeys(raw) {
      const results = await tinify.addKeys(raw);
      return { results, keys: keys.list() };
    },
    async removeKey(id) {
      keys.remove(id);
      return keys.list();
    },
    async checkKeys() {
      await tinify.checkAll();
      return keys.list();
    },

    async pickFolder() {
      try {
        root = await window.showDirectoryPicker({ mode: 'readwrite' });
        return root.name;
      } catch (err) {
        if (err.name === 'AbortError') return null;
        throw err;
      }
    },

    async createBatch() {
      const id = batchId();
      const name = `tinycompress-${id}`;
      current = {
        id,
        planner: new OutputPlanner(),
        files: new Map(),
        dir: root ? await root.getDirectoryHandle(name, { create: true }) : null,
        zippedCount: 0,
      };
      return root
        ? { id, label: `Saving to ${root.name}/${name}`, title: `${root.name}/${name}` }
        : { id, label: 'Results stay in this tab until you download the ZIP', title: '' };
    },

    async compress(file, { path, formats }, { onEvent }) {
      const segments = safeSegments(path);
      const sourceId = `${segments.join('/')}:${file.size}`;
      const batch = current;
      onEvent({ stage: 'received' });
      try {
        const result = await tinify.process({
          input: file,
          formats,
          onEvent,
          isDone: (mime, inputType) => {
            const target = batch.planner.target(segments, sourceId, mime, inputType);
            const saved = batch.files.get(target.rel);
            return saved ? describeOutput(mime, target.rel, saved.size) : null;
          },
          save: async (mime, inputType, data) => {
            const target = batch.planner.target(segments, sourceId, mime, inputType);
            const saved = { name: target.rel, size: data.byteLength, crc: crc32(new Uint8Array(data)) };
            if (batch.dir) saved.handle = await writeToFolder(batch.dir, target.segments, data);
            else saved.blob = new Blob([data], { type: mime });
            batch.files.set(target.rel, saved);
            return describeOutput(mime, target.rel, data.byteLength);
          },
        });
        return { ok: true, inputSize: file.size, outputs: result.outputs, keys: keys.list() };
      } catch (err) {
        if (err instanceof NoKeysError) return { ok: false, code: 'no_keys', message: err.message, keys: keys.list() };
        if (err instanceof TinifyError) return { ok: false, code: err.kind, message: err.message, keys: keys.list() };
        return { ok: false, code: 'error', message: err.message, keys: keys.list() };
      }
    },

    async outputUrl(_batch, path) {
      return URL.createObjectURL(await blobOf(current.files.get(path)));
    },

    // The archive is a Blob made of references to the stored files, so building it
    // does not copy every image into memory a second time.
    async downloadZip() {
      const zip = new ZipWriter();
      const parts = [];
      for (const saved of current.files.values()) {
        parts.push(zip.entry(saved), await blobOf(saved));
      }
      parts.push(...zip.finish());
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
      saveAs(url, `tinycompress-${current.id}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      current.zippedCount = current.files.size;
    },

    openFolder() {},
    hasUnsaved: () => Boolean(current && !current.dir && current.files.size > current.zippedCount),
    reset() {
      current = null;
    },
  };
}

async function createBackend() {
  const { ok, body } = await requestJson('/api/config').catch(() => ({ ok: false, body: {} }));
  return ok && body.mode === 'local' ? createLocalBackend() : createCloudBackend(body.defaultKeys || 0);
}
