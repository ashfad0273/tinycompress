const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { ZipWriter } = require('../public/core');

async function listFiles(dir, base = dir, found = []) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFiles(full, base, found);
    } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
      found.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return found;
}

// One file is read at a time to keep memory flat on large batches.
async function streamZip(files, res) {
  const zip = new ZipWriter();
  const write = async (chunk) => {
    if (!res.write(chunk)) await once(res, 'drain');
  };

  for (const file of files) {
    if (res.destroyed) return;
    const data = await fs.promises.readFile(file.full);
    await write(zip.entry({ name: file.name, size: data.length, crc: zlib.crc32(data) }));
    await write(data);
  }
  for (const chunk of zip.finish()) await write(chunk);
  res.end();
}

module.exports = { listFiles, streamZip };
