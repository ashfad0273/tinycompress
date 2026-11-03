const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

// A stand-in for api.tinify.com. Each key has a compression allowance.
const allowance = new Map();
const used = new Map();
const outputs = new Map();
const failures = { next500: 0, rate429: 0 };
let mock;
let mockUrl;

function authKey(req) {
  const raw = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
  return raw.split(':')[1];
}

function charge(key, res) {
  const count = used.get(key) || 0;
  if (count >= allowance.get(key)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Compression-Count': count });
    res.end(JSON.stringify({ error: 'TooManyRequests', message: 'Your monthly limit has been exceeded' }));
    return false;
  }
  used.set(key, count + 1);
  return true;
}

function startMock() {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const key = authKey(req);
      if (!allowance.has(key)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized', message: 'Credentials are invalid' }));
      }
      if (failures.next500 > 0 && body.length) {
        failures.next500--;
        res.writeHead(500);
        return res.end('boom');
      }
      if (failures.rate429 > 0 && body.length) {
        failures.rate429--;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'TooManyRequests', message: 'Slow down' }));
      }
      if (req.method === 'POST' && req.url === '/shrink') {
        if (!body.length) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Compression-Count': used.get(key) || 0 });
          return res.end(JSON.stringify({ error: 'InputMissing', message: 'File is empty' }));
        }
        if (!charge(key, res)) return undefined;
        const id = String(outputs.size + 1);
        outputs.set(id, { owner: key, type: 'image/png' });
        res.writeHead(201, {
          'Content-Type': 'application/json',
          Location: `${mockUrl}/output/${id}`,
          'Compression-Count': used.get(key),
        });
        return res.end(JSON.stringify({ input: { size: body.length, type: 'image/png' } }));
      }
      const output = outputs.get(req.url.split('/').pop());
      if (!output || output.owner !== key) {
        res.writeHead(404);
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': output.type });
        return res.end('shrunk');
      }
      if (!charge(key, res)) return undefined;
      const { convert } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': convert.type, 'Compression-Count': used.get(key) });
      return res.end(`converted:${convert.type}`);
    });
  });
  return new Promise((resolve) => mock.listen(0, '127.0.0.1', () => {
    mockUrl = `http://127.0.0.1:${mock.address().port}`;
    resolve();
  }));
}

let root;
let app;
let base;

before(startMock);
after(() => mock.close());

beforeEach(async () => {
  allowance.clear();
  used.clear();
  outputs.clear();
  failures.next500 = 0;
  failures.rate429 = 0;
  if (app) await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinycompress-'));
  app = createApp({
    dataDir: path.join(root, 'data'),
    outputDir: path.join(root, 'output'),
    apiBase: mockUrl,
    retryBaseMs: 1,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }));

const addKeys = async (keys) => (await fetch(`${base}/api/keys`, {
  method: 'POST',
  body: JSON.stringify({ keys }),
})).json();

const compress = async (rel, formats, batch = 'b1', body = 'imagebytes') => {
  const params = new URLSearchParams({ batch, path: rel, formats });
  const res = await fetch(`${base}/api/compress?${params}`, { method: 'POST', body });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, body: JSON.parse(text), events: [] };
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  return { status: res.status, body: events.at(-1), events };
};

test('streams every stage of an image in order', async () => {
  allowance.set('key-one-00000', 100);
  await addKeys('key-one-00000');
  const { events } = await compress('photo.png', 'original,webp');
  assert.deepStrictEqual(events.map((e) => e.stage), [
    'received', 'upload', 'shrunk', 'download', 'saved', 'convert', 'saved', 'result',
  ]);
  assert.deepStrictEqual(events[2].plan, ['image/png', 'image/webp']);
});

test('reports a key switch in the stream', async () => {
  allowance.set('key-one-00000', 1);
  allowance.set('key-two-00000', 100);
  await addKeys('key-one-00000 key-two-00000');
  const { events, body } = await compress('photo.png', 'webp');
  const change = events.find((e) => e.stage === 'switch');
  assert.strictEqual(change.reason, 'reached its limit');
  assert.ok(change.to);
  assert.strictEqual(body.ok, true);
});

test('rejects bad keys, stores good ones and never exposes them whole', async () => {
  allowance.set('goodkey-aaaa-1111', 10);
  const { results, keys } = await addKeys('goodkey-aaaa-1111\nbadkey-bbbb-2222\nshort');
  assert.deepStrictEqual(results.map((r) => r.added), [true, false, false]);
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(JSON.stringify(keys).includes('goodkey-aaaa-1111'), false);
});

test('creates every requested format and charges only for conversions', async () => {
  allowance.set('key-one-00000', 100);
  await addKeys('key-one-00000');
  const { body } = await compress('photo.png', 'original,png,webp,avif');
  assert.strictEqual(body.ok, true);
  assert.deepStrictEqual(body.outputs.map((o) => o.ext).sort(), ['avif', 'png', 'webp']);
  assert.strictEqual(used.get('key-one-00000'), 3); // shrink + webp + avif
  const dir = path.join(root, 'output', 'b1');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo.webp'), 'utf8'), 'converted:image/webp');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo.png'), 'utf8'), 'shrunk');
});

test('switches to the next key when one hits its limit mid image', async () => {
  allowance.set('key-one-00000', 2); // shrink + webp succeed, avif hits the limit
  allowance.set('key-two-00000', 100);
  await addKeys('key-one-00000 key-two-00000');
  const { body } = await compress('photo.png', 'webp,avif');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.outputs.length, 2);
  const [one, two] = body.keys;
  assert.strictEqual(one.status, 'exhausted');
  assert.strictEqual(two.inUse, true);
  // The second key re-uploads and only converts what is still missing.
  assert.strictEqual(used.get('key-two-00000'), 2);
});

test('reports no_keys when all run out, then continues with a new key', async () => {
  allowance.set('key-one-00000', 1);
  await addKeys('key-one-00000');
  assert.strictEqual((await compress('a.png', 'original')).body.ok, true);
  const blocked = await compress('b.png', 'original');
  assert.strictEqual(blocked.body.ok, false);
  assert.strictEqual(blocked.body.code, 'no_keys');
  allowance.set('key-two-00000', 5);
  await addKeys('key-two-00000');
  assert.strictEqual((await compress('b.png', 'original')).body.ok, true);
});

test('a key that goes invalid is skipped', async () => {
  allowance.set('key-one-00000', 5);
  allowance.set('key-two-00000', 5);
  await addKeys('key-one-00000 key-two-00000');
  allowance.delete('key-one-00000');
  const { body } = await compress('a.png', 'original');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.keys[0].status, 'invalid');
});

test('retries temporary server errors and short rate limits on the same key', async () => {
  allowance.set('key-one-00000', 50);
  allowance.set('key-two-00000', 50);
  await addKeys('key-one-00000 key-two-00000');
  failures.next500 = 2;
  failures.rate429 = 2;
  const { body } = await compress('a.png', 'original');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.keys[0].status, 'active');
  assert.strictEqual(used.get('key-two-00000') || 0, 0);
});

test('same-named sources do not overwrite each other', async () => {
  allowance.set('key-one-00000', 50);
  await addKeys('key-one-00000');
  const first = await compress('photo.png', 'webp');
  const second = await compress('photo.jpg', 'webp');
  assert.strictEqual(first.body.outputs[0].path, 'photo.webp');
  assert.strictEqual(second.body.outputs[0].path, 'photo-jpg.webp');
});

test('keeps folders but cannot write outside the batch', async () => {
  allowance.set('key-one-00000', 50);
  await addKeys('key-one-00000');
  const nested = await compress('album/2024/a.png', 'webp');
  assert.strictEqual(nested.body.outputs[0].path, 'album/2024/a.webp');
  const evil = await compress('../../../evil.png', 'webp');
  assert.strictEqual(evil.body.outputs[0].path, 'evil.webp');
  assert.ok(fs.existsSync(path.join(root, 'output', 'b1', 'evil.webp')));
  assert.strictEqual((await compress('x.png', 'webp', '../..')).status, 400);
});

test('blocks other websites and foreign hosts', async () => {
  const send = (headers) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/keys`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(await send({ Origin: 'https://evil.example' }), 403);
  assert.strictEqual(await send({ Host: 'evil.example' }), 403);
  assert.strictEqual(await send({}), 200);
});

test('zip download contains the batch', async () => {
  allowance.set('key-one-00000', 50);
  await addKeys('key-one-00000');
  await compress('album/a.png', 'webp');
  await compress('b.png', 'webp');
  const res = await fetch(`${base}/api/batches/b1/zip`);
  assert.strictEqual(res.status, 200);
  const zip = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.subarray(zip.length - 22);
  assert.strictEqual(end.readUInt32LE(0), 0x06054b50);
  assert.strictEqual(end.readUInt16LE(10), 2);
  assert.ok(zip.includes('album/a.webp'));
});

const { streamZip } = require('../lib/zip');

// Keeps only the tail of the stream so multi GB archives can be checked without storing them.
function tailWriter(keep) {
  const { Writable } = require('node:stream');
  let tail = Buffer.alloc(0);
  let total = 0;
  const writer = new Writable({
    write(chunk, _enc, done) {
      total += chunk.length;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > keep * 2) tail = tail.subarray(tail.length - keep);
      done();
    },
  });
  writer.result = () => ({ tail, total });
  return writer;
}

test('zip switches to ZIP64 past 65,535 files', async () => {
  const file = path.join(root, 'tiny.bin');
  fs.writeFileSync(file, 'x');
  const files = Array.from({ length: 70000 }, (_, i) => ({ full: file, name: `f${i}.bin` }));
  const out = tailWriter(1024);
  await streamZip(files, out);
  const { tail } = out.result();
  const end = tail.subarray(tail.length - 22);
  assert.strictEqual(end.readUInt16LE(10), 0xffff);
  const record = tail.subarray(tail.length - 22 - 20 - 56);
  assert.strictEqual(record.readUInt32LE(0), 0x06064b50);
  assert.strictEqual(record.readBigUInt64LE(32), 70000n);
});

test('zip stores 64 bit offsets past 4 GB', { timeout: 120000 }, async () => {
  const file = path.join(root, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024));
  const files = Array.from({ length: 140 }, (_, i) => ({ full: file, name: `f${i}.bin` }));
  const out = tailWriter(64 * 1024);
  await streamZip(files, out);
  const { tail, total } = out.result();
  assert.ok(total > 2 ** 32);
  const record = tail.subarray(tail.length - 22 - 20 - 56);
  assert.strictEqual(record.readUInt32LE(0), 0x06064b50);
  assert.strictEqual(record.readBigUInt64LE(32), 140n);
  // The last central entry carries its real offset in the ZIP64 extra field.
  const size = Number(record.readBigUInt64LE(40));
  const last = tail.subarray(tail.length - 98 - 46 - 'f139.bin'.length - 12, tail.length - 98);
  assert.strictEqual(tail.length > size, true);
  assert.strictEqual(last.readUInt32LE(0), 0x02014b50);
  assert.strictEqual(last.readUInt32LE(42), 0xffffffff);
  assert.ok(last.readBigUInt64LE(last.length - 8) > 2n ** 32n);
});

test('Cloudflare function only reaches TinyPNG and rewrites output links', async () => {
  const { onRequest } = await import('../functions/api/tinify/[[path]].js');
  allowance.set('key-one-00000', 5);
  const env = { TINIFY_API_URL: mockUrl };
  const auth = `Basic ${btoa('api:key-one-00000')}`;
  const call = (route, init = {}) => onRequest({
    env,
    params: { path: route.split('/') },
    request: new Request(`https://x.pages.dev/api/tinify/${route}`, { duplex: 'half', ...init }),
  });

  const shrink = await call('shrink', { method: 'POST', body: 'imagebytes', headers: { Authorization: auth } });
  assert.strictEqual(shrink.status, 201);
  const location = shrink.headers.get('location');
  assert.match(location, /^\/api\/tinify\/output\/\d+$/);
  assert.strictEqual(shrink.headers.get('compression-count'), '1');

  const output = await call(`output/${location.split('/').pop()}`, { headers: { Authorization: auth } });
  assert.strictEqual(await output.text(), 'shrunk');

  assert.strictEqual((await call('../../evil', { headers: { Authorization: auth } })).status, 404);
  assert.strictEqual((await call('shrink', { headers: { Authorization: auth } })).status, 405);
  assert.strictEqual((await call('shrink', { method: 'POST' })).status, 401);
  const foreign = await call('shrink', { method: 'POST', headers: { Authorization: auth, Origin: 'https://evil.example' } });
  assert.strictEqual(foreign.status, 403);
});

test('errors from the host are not mistaken for an exhausted key', async () => {
  const { TinifyClient, KeyRing } = require('../public/core');
  const host = http.createServer((req, res) => {
    req.resume();
    res.writeHead(429, { 'Content-Type': 'text/html' });
    res.end('<html>Worker exceeded daily limit</html>');
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const keys = new KeyRing();
  keys.add('key-one-00000', 'active');
  const client = new TinifyClient({ baseUrl: `http://127.0.0.1:${host.address().port}`, keys, retryBaseMs: 1 });
  await assert.rejects(
    client.process({ input: 'x', formats: ['webp'], isDone: () => null, save: async () => {}, onEvent() {} }),
    /rate limiting/,
  );
  assert.strictEqual(keys.keys[0].status, 'active');
  await new Promise((resolve) => host.close(resolve));
});

test('browser checksum matches zlib and its archive opens as valid entries', () => {
  const zlib = require('node:zlib');
  const { crc32, ZipWriter } = require('../public/core');
  const data = Buffer.from('tinycompress checksum sample');
  assert.strictEqual(crc32(data), zlib.crc32(data));
  const zip = new ZipWriter();
  const header = zip.entry({ name: 'a.txt', size: data.length, crc: crc32(data) });
  const archive = Buffer.concat([header, data, ...zip.finish()]);
  assert.strictEqual(archive.readUInt32LE(14), zlib.crc32(data));
  assert.strictEqual(archive.subarray(archive.length - 22).readUInt32LE(0), 0x06054b50);
});
