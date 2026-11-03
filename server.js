const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const { KeyStore } = require('./lib/keys');
const { listFiles, streamZip } = require('./lib/zip');
const {
  MIME,
  NoKeysError,
  OutputPlanner,
  TinifyClient,
  TinifyError,
  batchId,
  describeOutput,
  safeSegments,
} = require('./public/core');

const PUBLIC_DIR = path.join(__dirname, 'public');
const BATCH_ID = /^[\w-]{1,64}$/;
const FORMATS = new Set(['original', ...Object.keys(MIME)]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.jxl': 'image/jxl',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestSegments(relative) {
  const segments = safeSegments(relative);
  if (!segments.length) throw new HttpError(400, 'Missing file path');
  return segments;
}

function readBody(req, limit = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request is too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(400, 'Invalid JSON');
    throw err;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createApp({ dataDir, outputDir, apiBase, retryBaseMs }) {
  const keys = new KeyStore(path.join(dataDir, 'keys.json'));
  const tinify = new TinifyClient({ baseUrl: apiBase, keys, retryBaseMs });
  const planners = new Map();

  const batchDir = (id) => {
    if (!BATCH_ID.test(id || '')) throw new HttpError(400, 'Invalid batch id');
    return path.join(outputDir, id);
  };

  const plannerFor = (batch) => {
    if (!planners.has(batch)) planners.set(batch, new OutputPlanner());
    return planners.get(batch);
  };

  async function compress(req, res, url) {
    const batch = url.searchParams.get('batch');
    const dir = batchDir(batch);
    const segments = requestSegments(url.searchParams.get('path'));
    const formats = (url.searchParams.get('formats') || '').split(',').filter((f) => FORMATS.has(f));
    if (!formats.length) throw new HttpError(400, 'Pick at least one output format');

    const input = await readBody(req);
    if (!input.length) throw new HttpError(400, 'File is empty');
    const sourceId = `${segments.join('/')}:${input.length}`;
    await fs.promises.mkdir(dir, { recursive: true });
    const planner = plannerFor(batch);

    // The response is one JSON object per line: live stages, then a final `result` line.
    // Using this request's own connection means progress never takes a browser connection
    // away from the images being processed.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const emit = (event) => res.write(`${JSON.stringify(event)}\n`);
    emit({ stage: 'received' });

    try {
      const result = await tinify.process({
        input,
        formats,
        onEvent: emit,
        isDone: (mime, inputType) => {
          const target = planner.target(segments, sourceId, mime, inputType);
          if (!target.existing) return null;
          try {
            return describeOutput(mime, target.rel, fs.statSync(path.join(dir, ...target.segments)).size);
          } catch {
            return null; // Claimed by a failed attempt, nothing on disk yet.
          }
        },
        save: async (mime, inputType, data) => {
          const target = planner.target(segments, sourceId, mime, inputType);
          const full = path.join(dir, ...target.segments);
          await fs.promises.mkdir(path.dirname(full), { recursive: true });
          const tmp = `${full}.${crypto.randomUUID()}.tmp`;
          await fs.promises.writeFile(tmp, Buffer.from(data));
          await fs.promises.rename(tmp, full);
          return describeOutput(mime, target.rel, data.byteLength);
        },
      });
      emit({ stage: 'result', ok: true, inputSize: input.length, outputs: result.outputs, keys: keys.list() });
    } catch (err) {
      if (!(err instanceof NoKeysError) && !(err instanceof TinifyError)) console.error(err);
      const code = err instanceof NoKeysError ? 'no_keys' : err.kind || 'error';
      emit({ stage: 'result', ok: false, code, message: err.message, keys: keys.list() });
    }
    res.end();
  }

  async function addKeys(req, res) {
    const { keys: raw } = await readJson(req);
    const results = await tinify.addKeys(raw);
    sendJson(res, 200, { results, keys: keys.list() });
  }

  async function checkKeys(res) {
    await tinify.checkAll();
    sendJson(res, 200, { keys: keys.list() });
  }

  async function serveOutput(res, url) {
    const dir = batchDir(url.searchParams.get('batch'));
    const full = path.join(dir, ...requestSegments(url.searchParams.get('path')));
    const type = CONTENT_TYPES[path.extname(full).toLowerCase()];
    if (!type) throw new HttpError(404, 'Not found');
    await sendFile(res, full, type);
  }

  async function sendFile(res, full, type) {
    let stat;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(full).pipe(res);
  }

  async function downloadZip(res, id) {
    const dir = batchDir(id);
    let files;
    try {
      files = await listFiles(dir);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'Nothing compressed in this batch yet');
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="tinycompress-${id}.zip"`,
    });
    await streamZip(files, res);
  }

  async function openFolder(res, id) {
    const dir = batchDir(id);
    await fs.promises.mkdir(dir, { recursive: true });
    const opener = { win32: 'explorer', darwin: 'open' }[process.platform] || 'xdg-open';
    // explorer.exe exits non-zero even on success, so the result is ignored.
    execFile(opener, [dir], () => {});
    sendJson(res, 200, { ok: true });
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
    const type = CONTENT_TYPES[path.extname(full)];
    if (!type) throw new HttpError(404, 'Not found');
    await sendFile(res, full, type);
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, { mode: 'local' });
    if (method === 'GET' && pathname === '/api/keys') return sendJson(res, 200, { keys: keys.list() });
    if (method === 'POST' && pathname === '/api/keys') return addKeys(req, res);
    if (method === 'POST' && pathname === '/api/keys/check') return checkKeys(res);
    const keyMatch = pathname.match(/^\/api\/keys\/([\w-]+)$/);
    if (method === 'DELETE' && keyMatch) {
      keys.remove(keyMatch[1]);
      return sendJson(res, 200, { keys: keys.list() });
    }

    if (method === 'POST' && pathname === '/api/batches') {
      const id = batchId();
      return sendJson(res, 200, { id, dir: path.join(outputDir, id) });
    }
    if (method === 'POST' && pathname === '/api/compress') return compress(req, res, url);
    if (method === 'GET' && pathname === '/api/file') return serveOutput(res, url);

    const batchMatch = pathname.match(/^\/api\/batches\/([\w-]+)\/(zip|open)$/);
    if (batchMatch && method === 'GET' && batchMatch[2] === 'zip') return downloadZip(res, batchMatch[1]);
    if (batchMatch && method === 'POST' && batchMatch[2] === 'open') return openFolder(res, batchMatch[1]);

    if (method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, pathname);
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine's own pages may talk to the server. Checking Host stops DNS
      // rebinding and checking Origin stops other websites from using the saved keys.
      const port = server.address().port;
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origin = req.headers.origin;
      if (!allowed.includes(req.headers.host) || (origin && !allowed.map((h) => `http://${h}`).includes(origin))) {
        throw new HttpError(403, 'Forbidden');
      }
      await route(req, res, new URL(req.url, `http://${req.headers.host}`));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, err.status || 500, { code: err.code || 'error', message: err.message });
      }
    }
  });
  server.requestTimeout = 0;
  return { server, keys };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4711;
  const { server } = createApp({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'),
    outputDir: process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(__dirname, 'output'),
    apiBase: process.env.TINIFY_API_URL,
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is busy. Is TinyCompress already running?`);
    else console.error(err);
    process.exit(1);
  });
  // Bound to loopback only: nothing else on the network can reach this.
  server.listen(port, '127.0.0.1', () => {
    console.log(`TinyCompress is running at http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp };
