// Logic shared by the local Node server and the Cloudflare (browser only) version.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TinyCore = factory();
})(globalThis, function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_TRANSIENT_RETRIES = 4;
  const MAX_RATE_RETRIES = 3;

  const MIME = {
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
  };

  const EXT_BY_MIME = {
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/jpeg': '.jpg',
    'image/jxl': '.jxl',
  };

  const currentMonth = () => new Date().toISOString().slice(0, 7);
  const maskKey = (secret) => `${secret.slice(0, 4)}…${secret.slice(-4)}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function batchId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /* API keys */

  // Decides which key to use next. Keys are used in the order they were added, and a key
  // stays in use until it runs out. Subclasses decide where the keys are stored.
  class KeyRing {
    constructor(keys = []) {
      this.keys = keys;
    }

    save() {}

    // Tinify limits reset each calendar month, so an exhausted key from last month is usable again.
    refreshMonth() {
      const month = currentMonth();
      for (const k of this.keys) {
        if (k.month === month) continue;
        k.month = month;
        k.count = 0;
        if (k.status === 'exhausted') {
          k.status = 'active';
          k.note = '';
        }
      }
    }

    next() {
      this.refreshMonth();
      return this.keys.find((k) => k.status === 'active') || null;
    }

    has(secret) {
      return this.keys.some((k) => k.key === secret);
    }

    add(secret, status, count, note) {
      const entry = {
        id: crypto.randomUUID(),
        key: secret,
        status,
        count: count ?? 0,
        month: currentMonth(),
        note: note || '',
      };
      this.keys.push(entry);
      this.save();
      return entry;
    }

    remove(id) {
      this.keys = this.keys.filter((k) => k.id !== id);
      this.save();
    }

    setStatus(id, status, note) {
      const k = this.keys.find((x) => x.id === id);
      if (!k) return;
      k.status = status;
      k.note = note || '';
      this.save();
    }

    // Responses can arrive out of order, so the count only moves forward within a month.
    setCount(id, count) {
      const k = this.keys.find((x) => x.id === id);
      if (!k || !Number.isFinite(count)) return;
      k.count = Math.max(k.count, count);
      this.save();
    }

    // The interface only ever receives this view, never the full key.
    list() {
      this.refreshMonth();
      const current = this.keys.find((k) => k.status === 'active');
      return this.keys.map((k) => ({
        id: k.id,
        masked: maskKey(k.key),
        status: k.status,
        count: k.count,
        note: k.note,
        inUse: k === current,
      }));
    }
  }

  /* Tinify API */

  class TinifyError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.kind = kind; // invalid | limit | rate | client | transient
      this.status = status;
    }
  }

  class NoKeysError extends Error {}

  // Tinify errors are always JSON. Anything else came from a proxy in between, such as
  // Cloudflare's own daily limit page, and says nothing about the key being used.
  function classify(status, message, fromTinify) {
    if (!fromTinify) return status >= 400 && status < 500 && status !== 429 ? 'client' : 'transient';
    if (status === 401 || status === 403) return 'invalid';
    if (status === 429) return /month|limit/i.test(message) ? 'limit' : 'rate';
    if (status >= 400 && status < 500) return 'client';
    return 'transient';
  }

  function hostErrorMessage(status) {
    if (status === 413) return 'This image is over the 100 MB limit of this host';
    if (status === 429) return 'The host is rate limiting requests';
    return `The host returned HTTP ${status}`;
  }

  class TinifyClient {
    constructor({ baseUrl = 'https://api.tinify.com', keys, retryBaseMs = 1000 }) {
      this.baseUrl = baseUrl;
      this.keys = keys;
      this.retryBaseMs = retryBaseMs;
    }

    async request(key, method, url, { body, json } = {}) {
      const headers = { Authorization: `Basic ${btoa(`api:${key.key}`)}` };
      if (json) headers['Content-Type'] = 'application/json';

      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: json ? JSON.stringify(json) : body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new TinifyError('transient', `Network error: ${err.message}`);
      }

      this.keys.setCount(key.id, Number.parseInt(res.headers.get('compression-count'), 10));

      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      let message = null;
      try {
        message = JSON.parse(text).message;
      } catch {
        // Handled below as an error from something other than Tinify.
      }
      const fromTinify = message !== null;
      throw new TinifyError(
        classify(res.status, message || '', fromTinify),
        fromTinify ? message || `HTTP ${res.status}` : hostErrorMessage(res.status),
        res.status,
      );
    }

    // Sends an empty upload: Tinify rejects it as a bad request without charging a compression,
    // which still proves whether the key works and returns its count.
    async check(key) {
      try {
        await this.request(key, 'POST', `${this.baseUrl}/shrink`);
        return { status: 'active' };
      } catch (err) {
        if (err.kind === 'client') return { status: 'active' };
        if (err.kind === 'invalid') return { status: 'invalid', note: err.message };
        if (err.kind === 'limit' || err.kind === 'rate') return { status: 'exhausted', note: err.message };
        return { status: 'unknown', note: err.message };
      }
    }

    async addKeys(raw) {
      const tokens = [...new Set(String(raw || '').split(/[\s,;]+/).filter(Boolean))];
      const results = [];
      for (const token of tokens) {
        const label = maskKey(token);
        if (!/^[\w-]{8,}$/.test(token)) {
          results.push({ label, added: false, message: 'Does not look like an API key' });
        } else if (this.keys.has(token)) {
          results.push({ label, added: false, message: 'Already added' });
        } else {
          const check = await this.check({ id: null, key: token });
          if (check.status === 'invalid') {
            results.push({ label, added: false, message: 'Tinify rejected this key' });
          } else {
            const status = check.status === 'exhausted' ? 'exhausted' : 'active';
            const entry = this.keys.add(token, status, 0, check.note);
            await this.check(entry); // Fills in the real compression count.
            results.push({ label, added: true, message: status === 'exhausted' ? 'Added, but at its limit' : 'Added' });
          }
        }
      }
      return results;
    }

    // Lets keys recover after an upgrade or a false limit, and refreshes every count.
    async checkAll() {
      this.keys.refreshMonth();
      await Promise.all(this.keys.keys.map(async (key) => {
        const check = await this.check(key);
        if (check.status !== 'unknown') this.keys.setStatus(key.id, check.status, check.note);
      }));
    }

    // Compresses `input` and saves every requested format.
    // Any key failure restarts from the upload on the next key, because Tinify output URLs
    // belong to the key that created them. `isDone` skips formats saved by an earlier attempt.
    // `onEvent` reports each stage as it happens so the interface can show the real process.
    async process({ input, formats, isDone, save, onEvent }) {
      let transient = 0;
      let rate = 0;

      const dropKey = (key, status, message) => {
        this.keys.setStatus(key.id, status, message);
        const next = this.keys.next();
        onEvent({
          stage: 'switch',
          from: maskKey(key.key),
          to: next ? maskKey(next.key) : null,
          reason: status === 'invalid' ? 'was rejected' : 'reached its limit',
          keys: this.keys.list(),
        });
      };

      for (;;) {
        const key = this.keys.next();
        if (!key) throw new NoKeysError('No usable API keys left');

        try {
          return await this.runWithKey(key, { input, formats, isDone, save, onEvent });
        } catch (err) {
          if (!(err instanceof TinifyError)) throw err;
          switch (err.kind) {
            case 'limit':
              dropKey(key, 'exhausted', err.message);
              rate = 0;
              break;
            case 'invalid':
              dropKey(key, 'invalid', err.message);
              rate = 0;
              break;
            case 'rate':
              if (++rate > MAX_RATE_RETRIES) {
                dropKey(key, 'exhausted', err.message);
                rate = 0;
              } else {
                onEvent({ stage: 'retry', reason: 'TinyPNG asked to slow down', attempt: rate, of: MAX_RATE_RETRIES });
                await sleep(this.retryBaseMs * 2 ** rate);
              }
              break;
            case 'transient':
              if (++transient > MAX_TRANSIENT_RETRIES) throw err;
              onEvent({ stage: 'retry', reason: 'Temporary error', attempt: transient, of: MAX_TRANSIENT_RETRIES });
              await sleep(this.retryBaseMs * 2 ** transient);
              break;
            default:
              throw err;
          }
        }
      }
    }

    async runWithKey(key, { input, formats, isDone, save, onEvent }) {
      onEvent({ stage: 'upload', key: maskKey(key.key) });
      const shrink = await this.request(key, 'POST', `${this.baseUrl}/shrink`, { body: input });
      const location = shrink.headers.get('location');
      if (!location) throw new TinifyError('transient', 'Tinify response had no output URL');
      const info = await shrink.json();
      const inputType = info.input?.type;

      // "original" and a matching target format are the same file, so only pay for it once.
      const mimes = new Set(formats.map((f) => (f === 'original' ? inputType : MIME[f])));
      onEvent({ stage: 'shrunk', inputType, compressedSize: info.output?.size, plan: [...mimes] });
      const outputs = [];

      for (const mime of mimes) {
        const done = isDone(mime, inputType);
        if (done) {
          outputs.push(done);
          onEvent({ stage: 'saved', output: done });
          continue;
        }
        // Downloading the shrink result is free. Only a real conversion costs a compression.
        onEvent({ stage: mime === inputType ? 'download' : 'convert', mime });
        const res = mime === inputType
          ? await this.request(key, 'GET', location)
          : await this.request(key, 'POST', location, { json: { convert: { type: mime } } });
        const output = await save(mime, inputType, await res.arrayBuffer());
        outputs.push(output);
        onEvent({ stage: 'saved', output });
      }

      return { inputType, outputs };
    }
  }

  /* Output names */

  // Turns a relative path from the browser into segments that are safe on any OS.
  function safeSegments(relative) {
    return String(relative)
      .split(/[\\/]+/)
      .filter((s) => s && s !== '.' && s !== '..')
      .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_'))
      .map((s) => (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s) ? `_${s}` : s));
  }

  function extname(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot) : '';
  }

  function describeOutput(mime, rel, size) {
    return { mime, ext: extname(rel).slice(1).toLowerCase(), path: rel, size };
  }

  // Picks output names for one batch. Stops photo.png and photo.jpg from overwriting
  // each other's photo.webp, and lets a retry recognise what it already saved.
  class OutputPlanner {
    constructor() {
      this.taken = new Map();
    }

    target(segments, sourceId, mime, inputType) {
      const file = segments.at(-1);
      const sourceExt = extname(file);
      const stem = file.slice(0, file.length - sourceExt.length) || file;
      const ext = mime === inputType && sourceExt ? sourceExt : EXT_BY_MIME[mime];
      const dir = segments.slice(0, -1);
      const tag = sourceExt.slice(1).replace(/\W/g, '') || 'file';

      for (let attempt = 0; ; attempt++) {
        let name = `${stem}${ext}`;
        if (attempt === 1) name = `${stem}-${tag}${ext}`;
        if (attempt > 1) name = `${stem}-${tag}-${attempt}${ext}`;
        const rel = [...dir, name].join('/');
        const owner = this.taken.get(rel.toLowerCase());
        if (owner === undefined || owner === sourceId) {
          this.taken.set(rel.toLowerCase(), sourceId);
          return { rel, segments: [...dir, name], existing: owner === sourceId };
        }
      }
    }
  }

  /* ZIP */

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const MAX_16 = 0xffff;
  const MAX_32 = 0xffffffff;

  function record(size) {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // Builds an archive of stored entries, since images are already compressed. It only
  // produces the headers, so callers can feed file data without holding it all in memory.
  // ZIP64 records are added whenever a batch outgrows the classic 65,535 file or 4 GB limits.
  class ZipWriter {
    constructor() {
      const now = new Date();
      this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      this.date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      this.central = [];
      this.centralSize = 0;
      this.offset = 0;
      this.count = 0;
    }

    // Returns the bytes to write before an entry's data.
    entry({ name, size, crc }) {
      const FLAGS = 0x0800; // UTF-8 names
      const nameBytes = new TextEncoder().encode(name);
      const start = this.offset;
      const version = size >= MAX_32 || start >= MAX_32 ? 45 : 20;

      const local = record(30);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, version, true);
      local.view.setUint16(6, FLAGS, true);
      local.view.setUint16(10, this.time, true);
      local.view.setUint16(12, this.date, true);
      local.view.setUint32(14, crc, true);
      local.view.setUint32(18, Math.min(size, MAX_32), true);
      local.view.setUint32(22, Math.min(size, MAX_32), true);
      local.view.setUint16(26, nameBytes.length, true);

      let localExtra = new Uint8Array(0);
      if (size >= MAX_32) {
        const extra = record(20);
        extra.view.setUint16(0, 0x0001, true);
        extra.view.setUint16(2, 16, true);
        extra.view.setBigUint64(4, BigInt(size), true);
        extra.view.setBigUint64(12, BigInt(size), true);
        localExtra = extra.bytes;
        local.view.setUint16(28, localExtra.length, true);
      }

      const fields = [];
      if (size >= MAX_32) fields.push(size, size);
      if (start >= MAX_32) fields.push(start);
      let centralExtra = new Uint8Array(0);
      if (fields.length) {
        const extra = record(4 + fields.length * 8);
        extra.view.setUint16(0, 0x0001, true);
        extra.view.setUint16(2, fields.length * 8, true);
        fields.forEach((value, i) => extra.view.setBigUint64(4 + i * 8, BigInt(value), true));
        centralExtra = extra.bytes;
      }

      const header = record(46);
      header.view.setUint32(0, 0x02014b50, true);
      header.view.setUint16(4, version, true);
      header.view.setUint16(6, version, true);
      header.view.setUint16(8, FLAGS, true);
      header.view.setUint16(12, this.time, true);
      header.view.setUint16(14, this.date, true);
      header.view.setUint32(16, crc, true);
      header.view.setUint32(20, Math.min(size, MAX_32), true);
      header.view.setUint32(24, Math.min(size, MAX_32), true);
      header.view.setUint16(28, nameBytes.length, true);
      header.view.setUint16(30, centralExtra.length, true);
      header.view.setUint32(42, Math.min(start, MAX_32), true);
      const central = concat([header.bytes, nameBytes, centralExtra]);
      this.central.push(central);
      this.centralSize += central.length;
      this.count++;

      const before = concat([local.bytes, nameBytes, localExtra]);
      this.offset += before.length + size;
      return before;
    }

    // Returns the bytes that close the archive.
    finish() {
      const chunks = [...this.central];
      const centralStart = this.offset;
      let at = centralStart + this.centralSize;

      if (this.count >= MAX_16 || centralStart >= MAX_32 || this.centralSize >= MAX_32) {
        const zip64 = record(56);
        zip64.view.setUint32(0, 0x06064b50, true);
        zip64.view.setBigUint64(4, 44n, true);
        zip64.view.setUint16(12, 45, true);
        zip64.view.setUint16(14, 45, true);
        zip64.view.setBigUint64(24, BigInt(this.count), true);
        zip64.view.setBigUint64(32, BigInt(this.count), true);
        zip64.view.setBigUint64(40, BigInt(this.centralSize), true);
        zip64.view.setBigUint64(48, BigInt(centralStart), true);
        chunks.push(zip64.bytes);

        const locator = record(20);
        locator.view.setUint32(0, 0x07064b50, true);
        locator.view.setBigUint64(8, BigInt(at), true);
        locator.view.setUint32(16, 1, true);
        chunks.push(locator.bytes);
        at += 76;
      }

      const end = record(22);
      end.view.setUint32(0, 0x06054b50, true);
      end.view.setUint16(8, Math.min(this.count, MAX_16), true);
      end.view.setUint16(10, Math.min(this.count, MAX_16), true);
      end.view.setUint32(12, Math.min(this.centralSize, MAX_32), true);
      end.view.setUint32(16, Math.min(centralStart, MAX_32), true);
      chunks.push(end.bytes);
      return chunks;
    }
  }

  return {
    MIME,
    KeyRing,
    TinifyClient,
    TinifyError,
    NoKeysError,
    OutputPlanner,
    ZipWriter,
    batchId,
    crc32,
    describeOutput,
    extname,
    maskKey,
    safeSegments,
  };
});
