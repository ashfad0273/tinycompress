const fs = require('node:fs');
const path = require('node:path');
const { KeyRing } = require('../public/core');

// Keeps the API keys on disk for the local version.
class KeyStore extends KeyRing {
  constructor(file) {
    let keys = [];
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    super(keys);
    this.file = file;
    this.saving = Promise.resolve();
  }

  save() {
    if (this.savePending) return;
    this.savePending = true;
    this.saving = this.saving.then(async () => {
      this.savePending = false;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.keys, null, 2));
      await fs.promises.rename(tmp, this.file);
    }).catch((err) => console.error('Could not save keys:', err.message));
  }
}

module.exports = { KeyStore };
