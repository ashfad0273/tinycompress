'use strict';

const SUPPORTED = /\.(png|jpe?g|jfif|webp|avif)$/i;
const MIME_BY_FORMAT = { png: 'image/png', webp: 'image/webp', avif: 'image/avif' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
const LABELS = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/avif': 'AVIF', 'image/jxl': 'JXL' };
const FREE_PLAN_LIMIT = 500;

// Browsers allow about 6 connections to a site. One stays free so keys can be
// added mid-batch. Everything else waits in the queue, which has no size limit.
const PARALLEL_IMAGES = 5;

// Browsers cap how tall an element can be, so very long lists map scroll position to rows.
const MAX_SPACER_PX = 20_000_000;

const $ = (id) => document.getElementById(id);

let backend;

const state = {
  items: [],
  seen: new Set(),
  nextIndex: 0,
  working: new Set(),
  active: false,
  blocked: false,
  batch: null,
  keys: [],
  nextId: 1,
  rows: new Map(),
  elapsedMs: 0,
  resumedAt: 0,
};

const counts = { done: 0, failed: 0, inputBytes: 0, outputBytes: 0 };

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function iconEl(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function iconButton(name, label, onClick) {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(iconEl(name));
  button.addEventListener('click', onClick);
  return button;
}

function toast(text, tone = '') {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = text;
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 4500);
}

/* API keys */

function hasUsableKey() {
  return state.keys.some((k) => k.status === 'active');
}

function setKeys(keys) {
  const known = new Set(state.keys.map((k) => k.id));
  state.keys = keys;
  renderKeys(known);
  scheduleEstimate();
}

const STATUS_TEXT = { active: 'Ready', exhausted: 'Limit reached', invalid: 'Invalid key' };

function renderKeys(known) {
  $('key-list').replaceChildren(...state.keys.map((key) => {
    const li = document.createElement('li');
    li.classList.add(key.status);
    if (key.inUse) li.classList.add('current');
    if (known && !known.has(key.id)) li.classList.add('new');

    const top = document.createElement('div');
    top.className = 'key-top';
    const dot = document.createElement('span');
    dot.className = `dot ${key.inUse ? 'using' : key.status}`;
    const code = document.createElement('code');
    code.textContent = key.masked;
    const remove = iconButton('x', `Remove key ${key.masked}`, async () => {
      setKeys(await backend.removeKey(key.id));
      syncKeyForm();
    });
    top.append(dot, code, remove);

    const info = document.createElement('div');
    info.className = 'key-state';
    const label = key.inUse ? 'In use' : STATUS_TEXT[key.status];
    info.textContent = `${label} · ${key.count.toLocaleString()} used this month`;
    if (key.note && key.status !== 'active') info.title = key.note;

    const meter = document.createElement('div');
    meter.className = 'meter';
    const bar = document.createElement('div');
    bar.style.width = `${key.status === 'active' ? Math.min(100, (key.count / FREE_PLAN_LIMIT) * 100) : 100}%`;
    meter.append(bar);

    li.append(top, info, meter);
    return li;
  }));
}

// The form stays open until there is a key, then tucks away behind "Add key".
function syncKeyForm(forceOpen) {
  const open = forceOpen ?? !state.keys.length;
  $('key-form').classList.toggle('open', open);
  $('toggle-keys').hidden = !state.keys.length;
  $('recheck').hidden = !state.keys.length;
  $('toggle-keys').textContent = open ? 'Cancel' : 'Add key';
}

$('toggle-keys').addEventListener('click', () => {
  const open = !$('key-form').classList.contains('open');
  syncKeyForm(open);
  if (open) $('key-input').focus();
});

$('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('key-input');
  if (!input.value.trim()) return;
  const message = $('key-message');
  message.textContent = 'Checking keys…';
  const { results, keys } = await backend.addKeys(input.value);
  input.value = '';
  setKeys(keys);
  message.textContent = results.map((r) => `${r.label}: ${r.message}`).join('\n');
  syncKeyForm(false);
  resumeIfUnblocked();
});

$('recheck').addEventListener('click', async () => {
  $('key-message').textContent = 'Checking keys…';
  setKeys(await backend.checkKeys());
  $('key-message').textContent = '';
  toast('Keys rechecked');
  resumeIfUnblocked();
});

/* Adding files */

function addFiles(entries) {
  let skipped = 0;
  let added = 0;
  for (const { file, rel } of entries) {
    if (!SUPPORTED.test(file.name)) {
      skipped++;
      continue;
    }
    const signature = `${rel}|${file.size}|${file.lastModified}`;
    if (state.seen.has(signature)) continue;
    state.seen.add(signature);
    state.items.push({
      id: state.nextId++,
      index: state.items.length,
      signature,
      file,
      rel,
      status: 'pending',
      steps: [],
      outputs: [],
      detail: 'In queue',
      tone: '',
      progress: 0,
      isNew: true,
    });
    added++;
  }
  if (added) toast(`Added ${added.toLocaleString()} ${added === 1 ? 'image' : 'images'}`);
  if (skipped) toast(`Skipped ${skipped.toLocaleString()} files that aren't PNG, JPEG, WebP or AVIF`, 'warn');
  if (added) {
    scheduleEstimate();
    refresh();
  }
  if (added && state.active) pump();
}

// readEntries returns at most 100 entries per call, so it must be called until empty.
async function readDirectory(dirEntry, out, onFound) {
  const reader = dirEntry.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const entry of batch) await readEntry(entry, out, onFound);
  }
}

async function readEntry(entry, out, onFound) {
  if (entry.isDirectory) {
    await readDirectory(entry, out, onFound);
  } else {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, rel: entry.fullPath.replace(/^\/+/, '') });
    onFound(out.length);
  }
}

// The whole window accepts drops, so there is no small target to aim for.
let dragDepth = 0;
const isFileDrag = (event) => [...event.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  $('overlay').classList.add('show');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('overlay').classList.remove('show');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('overlay').classList.remove('show');
  // Entries stop being available once this handler yields, so collect them first.
  const entries = [...event.dataTransfer.items]
    .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) return;
  const out = [];
  let lastShown = 0;
  const onFound = (found) => {
    if (found - lastShown < 200) return;
    lastShown = found;
    showBanner(`Reading files… ${found.toLocaleString()} found`);
  };
  for (const entry of entries) await readEntry(entry, out, onFound);
  hideBanner();
  addFiles(out);
});

const pickFiles = () => $('file-input').click();
const pickFolder = () => $('folder-input').click();
$('hero').addEventListener('click', pickFiles);
$('hero-folder').addEventListener('click', pickFolder);
$('add-files').addEventListener('click', pickFiles);
$('add-folder').addEventListener('click', pickFolder);
for (const id of ['file-input', 'folder-input']) {
  $(id).addEventListener('change', (event) => {
    addFiles([...event.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
    event.target.value = '';
  });
}

/* Queue */

function selectedFormats() {
  return [...document.querySelectorAll('#formats input:checked')].map((input) => input.value);
}

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function setActive(active) {
  if (active && !state.active) state.resumedAt = performance.now();
  if (!active && state.active) state.elapsedMs += performance.now() - state.resumedAt;
  state.active = active;
}

async function start() {
  if (!selectedFormats().length) {
    toast('Pick at least one output format', 'warn');
    return;
  }
  if (!state.keys.length) {
    syncKeyForm(true);
    $('key-input').focus();
    toast('Add an API key first', 'warn');
    return;
  }
  if (!state.batch) {
    const batch = await backend.createBatch();
    state.batch = batch.id;
    $('out-dir').textContent = batch.label;
    $('out-dir').title = batch.title;
  }
  setActive(true);
  state.blocked = false;
  hideBanner();
  refresh();
  pump();
}

function pump() {
  while (state.active && !state.blocked && state.working.size < PARALLEL_IMAGES) {
    const item = nextPending();
    if (!item) break;
    state.working.add(item);
    run(item).finally(() => {
      state.working.delete(item);
      refresh();
      pump();
    });
  }
  if (state.active && !state.working.size && !nextPending() && !state.blocked) {
    setActive(false);
    announceFinish();
    refresh();
  }
}

function announceFinish() {
  if (counts.failed) {
    toast(`Finished. ${counts.done.toLocaleString()} done, ${counts.failed.toLocaleString()} failed`, 'warn');
  } else {
    const next = backend.hasUnsaved() ? '. Download the ZIP to keep them' : '';
    toast(`All ${counts.done.toLocaleString()} images are done${next}`, 'good');
  }
}

function nextPending() {
  while (state.nextIndex < state.items.length) {
    const item = state.items[state.nextIndex];
    if (item.status === 'pending') return item;
    state.nextIndex++;
  }
  return null;
}

function planSteps(item) {
  const ext = item.file.name.split('.').pop().toLowerCase();
  const mimes = new Set(selectedFormats().map((f) => (f === 'original' ? MIME_BY_EXT[ext] : MIME_BY_FORMAT[f])));
  return [
    { id: 'send', label: 'Read', state: 'wait' },
    { id: 'shrink', label: 'Compress', state: 'wait' },
    ...[...mimes].map((mime) => ({ id: mime, label: LABELS[mime], state: 'wait' })),
  ];
}

function setStep(item, id, stepState, extra) {
  const step = item.steps.find((s) => s.id === id);
  if (step) Object.assign(step, { state: stepState }, extra);
  updateProgress(item);
}

function updateProgress(item) {
  let finished = 0;
  let running = 0;
  for (const step of item.steps) {
    if (step.state === 'ok') finished++;
    if (step.state === 'run') running = step.fraction ?? 0.5;
  }
  item.progress = item.steps.length ? (finished + running) / item.steps.length : 0;
}

function say(item, detail, tone = '') {
  item.detail = detail;
  item.tone = tone;
}

// Moves one image's row forward as each real stage is reported by the server.
function applyEvent(item, event) {
  switch (event.stage) {
    case 'received':
      setStep(item, 'send', 'ok');
      break;
    case 'upload':
      setStep(item, 'shrink', 'run');
      say(item, `Compressing with key ${event.key}`);
      break;
    case 'shrunk': {
      const size = event.compressedSize ? formatSize(event.compressedSize) : '';
      setStep(item, 'shrink', 'ok', { info: size });
      const kept = new Map(item.steps.map((s) => [s.id, s]));
      item.steps = [
        kept.get('send'),
        kept.get('shrink'),
        ...event.plan.map((mime) => kept.get(mime) || { id: mime, label: LABELS[mime], state: 'wait' }),
      ];
      updateProgress(item);
      say(item, size ? `Compressed to ${size}` : 'Compressed');
      break;
    }
    case 'convert':
      setStep(item, event.mime, 'run');
      say(item, `Converting to ${LABELS[event.mime]}`);
      break;
    case 'download':
      setStep(item, event.mime, 'run');
      say(item, `Downloading compressed ${LABELS[event.mime]}`);
      break;
    case 'saved':
      setStep(item, event.output.mime, 'ok', { size: event.output.size, path: event.output.path });
      say(item, `Saved ${event.output.path}`);
      break;
    case 'switch': {
      if (event.keys) setKeys(event.keys);
      for (const step of item.steps) {
        if (step.state === 'run' || step.id === 'shrink') {
          step.state = 'wait';
          step.info = '';
        }
      }
      updateProgress(item);
      const text = event.to
        ? `Key ${event.from} ${event.reason}, switching to ${event.to}`
        : `Key ${event.from} ${event.reason}, no keys left`;
      say(item, text, 'warn');
      if (state.lastSwitch !== event.from) {
        state.lastSwitch = event.from;
        toast(text, 'warn');
      }
      break;
    }
    case 'retry':
      say(item, `${event.reason}, retry ${event.attempt} of ${event.of}`, 'warn');
      break;
    default:
  }
  refresh();
}

async function run(item) {
  item.status = 'working';
  item.steps = planSteps(item);
  setStep(item, 'send', 'run');
  say(item, 'Reading file');
  refresh();

  try {
    const result = await backend.compress(
      item.file,
      { batch: state.batch, path: item.rel, formats: selectedFormats() },
      {
        onEvent: (event) => applyEvent(item, event),
        onUpload: (fraction) => {
          setStep(item, 'send', 'run', { fraction });
          say(item, `Reading file ${Math.round(fraction * 100)}%`);
          refresh();
        },
      },
    );
    if (result.keys) setKeys(result.keys);

    if (result.ok) {
      item.status = 'done';
      item.justFinished = true;
      item.outputs = result.outputs;
      item.progress = 1;
      const smallest = Math.min(...result.outputs.map((o) => o.size));
      item.inputSize = result.inputSize;
      item.smallest = smallest;
      counts.done++;
      counts.inputBytes += result.inputSize;
      counts.outputBytes += smallest;
      say(item, `Saved ${result.outputs.map((o) => o.path).join(', ')}`);
    } else if (result.code === 'no_keys') {
      // Not this image's fault: put it back and wait for a working key.
      item.status = 'pending';
      item.steps = [];
      item.progress = 0;
      say(item, 'Waiting for an API key', 'warn');
      state.nextIndex = Math.min(state.nextIndex, item.index);
      block();
    } else {
      fail(item, result.message);
    }
  } catch (err) {
    fail(item, err.message);
  }
}

function fail(item, message) {
  item.status = 'failed';
  item.justFinished = true;
  say(item, message, 'bad');
  counts.failed++;
}

function block() {
  state.blocked = true;
  const waiting = state.items.length - counts.done - counts.failed - state.working.size + 1;
  showBanner(state.keys.length
    ? `All API keys are out of compressions, so about ${waiting.toLocaleString()} images are waiting. Add another key and the batch continues on its own.`
    : `Add an API key to continue. About ${waiting.toLocaleString()} images are waiting.`);
  syncKeyForm(true);
}

function resumeIfUnblocked() {
  if (state.blocked && hasUsableKey()) {
    state.blocked = false;
    state.lastSwitch = null;
    hideBanner();
    refresh();
    pump();
  }
}

function retryItem(item) {
  item.status = 'pending';
  item.steps = [];
  item.progress = 0;
  say(item, 'In queue');
  counts.failed--;
  state.nextIndex = Math.min(state.nextIndex, item.index);
  refresh();
  if (state.active) pump();
  else start();
}

function removeItem(item) {
  if (item.status === 'failed') counts.failed--;
  state.seen.delete(item.signature);
  state.items.splice(item.index, 1);
  state.items.forEach((other, index) => { other.index = index; });
  state.nextIndex = 0;
  scheduleEstimate();
  refresh();
}

$('start').addEventListener('click', () => {
  if (state.active) {
    setActive(false);
    refresh();
  } else {
    start();
  }
});

$('retry').addEventListener('click', () => {
  state.items.forEach((item) => {
    if (item.status === 'failed') {
      item.status = 'pending';
      item.steps = [];
      item.progress = 0;
      say(item, 'In queue');
    }
  });
  counts.failed = 0;
  state.nextIndex = 0;
  start();
});

$('clear').addEventListener('click', () => {
  if (backend.hasUnsaved() && !window.confirm('Clear the list? Results you have not downloaded will be lost.')) return;
  backend.reset();
  state.items = [];
  state.seen.clear();
  state.nextIndex = 0;
  state.batch = null;
  state.blocked = false;
  state.elapsedMs = 0;
  Object.assign(counts, { done: 0, failed: 0, inputBytes: 0, outputBytes: 0 });
  $('out-dir').textContent = '';
  $('list').scrollTop = 0;
  $('follow').checked = true;
  hideBanner();
  scheduleEstimate();
  refresh();
});

$('open').addEventListener('click', () => backend.openFolder(state.batch));
$('zip').addEventListener('click', () => backend.downloadZip(state.batch));

/* Where results go on the Cloudflare version */

$('pick-dest').addEventListener('click', async () => {
  const name = await backend.pickFolder();
  if (name) $('save-status').textContent = `Saving into ${name}, in a new subfolder for each batch.`;
});

/* Before and after comparison */

let compareUrls = [];

async function openOutput(path) {
  const url = await backend.outputUrl(state.batch, path);
  window.open(url, '_blank', 'noopener');
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function openCompare(item) {
  $('compare-title').textContent = item.rel;
  const original = URL.createObjectURL(item.file);
  compareUrls = [original];
  $('compare-before').src = original;
  $('compare-left').textContent = `Original ${formatSize(item.inputSize)}`;

  const buttons = item.outputs.map((output) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = output.ext;
    button.addEventListener('click', async () => {
      buttons.forEach((b) => b.classList.toggle('on', b === button));
      const url = await backend.outputUrl(state.batch, output.path);
      compareUrls.push(url);
      $('compare-after').src = url;
      const percent = Math.round((1 - output.size / item.inputSize) * 100);
      $('compare-right').textContent = `${output.ext.toUpperCase()} ${formatSize(output.size)}, ${percent}% smaller`;
    });
    return button;
  });
  $('compare-formats').replaceChildren(...buttons);
  buttons[0].click();
  $('compare-range').value = 50;
  moveCompare();
  $('compare').showModal();
}

function moveCompare() {
  const value = $('compare-range').value;
  $('compare-after').style.clipPath = `inset(0 0 0 ${value}%)`;
  $('compare-handle').style.left = `${value}%`;
}

$('compare-range').addEventListener('input', moveCompare);
$('compare-close').addEventListener('click', () => $('compare').close());
$('compare').addEventListener('click', (event) => {
  if (event.target === $('compare')) $('compare').close();
});
$('compare').addEventListener('close', () => {
  compareUrls.forEach((url) => URL.revokeObjectURL(url));
  compareUrls = [];
  $('compare-before').removeAttribute('src');
  $('compare-after').removeAttribute('src');
});

/* Rendering */

let estimateTimer = null;
function scheduleEstimate() {
  if (estimateTimer) return;
  estimateTimer = setTimeout(() => {
    estimateTimer = null;
    renderEstimate();
  }, 400);
}

function renderEstimate() {
  const hint = $('estimate');
  const formats = selectedFormats();
  hint.classList.remove('warn');
  if (!formats.length) {
    hint.textContent = 'Pick at least one format.';
    hint.classList.add('warn');
    return;
  }
  const targets = formats.filter((f) => f !== 'original').map((f) => MIME_BY_FORMAT[f]);
  let total = 0;
  for (const item of state.items) {
    if (item.status !== 'pending') continue;
    const source = MIME_BY_EXT[item.file.name.split('.').pop().toLowerCase()];
    total += 1 + new Set(targets.filter((mime) => mime !== source)).size;
  }
  if (!total) {
    hint.textContent = 'Each upload uses 1 compression. Each conversion to another format uses 1 more.';
    return;
  }
  const left = state.keys
    .filter((k) => k.status === 'active')
    .reduce((sum, k) => sum + Math.max(0, FREE_PLAN_LIMIT - k.count), 0);
  hint.textContent = `This batch needs about ${total.toLocaleString()} compressions.`;
  if (total > left) {
    hint.textContent += ` On the free plan your keys have about ${left.toLocaleString()} left, so add more or the batch will pause.`;
    hint.classList.add('warn');
  }
}

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    render();
  });
}

function timeLeft() {
  const finished = counts.done + counts.failed;
  const elapsed = state.elapsedMs + (state.active ? performance.now() - state.resumedAt : 0);
  if (finished < 3 || !elapsed) return '';
  const seconds = ((state.items.length - finished) * elapsed) / finished / 1000;
  if (seconds < 60) return 'Less than a minute left';
  if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min left`;
  return `About ${(seconds / 3600).toFixed(1)} hours left`;
}

function render() {
  const total = state.items.length;
  const finished = counts.done + counts.failed;
  const hasPending = Boolean(nextPending());
  const busy = state.working.size > 0;

  document.body.classList.toggle('running', state.active && !state.blocked);
  $('hero').hidden = total > 0;
  $('hero-folder').hidden = total > 0;
  $('queue').hidden = total === 0;

  // In-flight images count partially so the main bar moves as steps finish.
  let progress = finished;
  for (const item of state.working) progress += item.progress;
  $('progress').style.width = total ? `${(progress / total) * 100}%` : '0';

  const count = total.toLocaleString();
  let headline;
  if (state.blocked) headline = `Waiting for an API key, ${finished.toLocaleString()} of ${count} finished`;
  else if (state.active) headline = `Compressing, ${finished.toLocaleString()} of ${count} finished`;
  else if (finished && hasPending) headline = `Paused, ${finished.toLocaleString()} of ${count} finished`;
  else if (finished) headline = counts.failed ? `${counts.done.toLocaleString()} of ${count} done, ${counts.failed.toLocaleString()} failed` : `All ${count} done`;
  else headline = `${count} ${total === 1 ? 'image' : 'images'} ready`;
  if ($('headline').textContent !== headline) $('headline').textContent = headline;

  const parts = [];
  if (counts.done && counts.inputBytes) {
    const percent = Math.round((1 - counts.outputBytes / counts.inputBytes) * 100);
    parts.push(`${formatSize(counts.inputBytes)} down to ${formatSize(counts.outputBytes)}, ${percent}% smaller`);
  }
  if (state.active && !state.blocked) {
    const left = timeLeft();
    if (left) parts.push(left);
  }
  $('subline').textContent = parts.join(' · ');
  document.title = state.active ? `${finished.toLocaleString()}/${count} · TinyCompress` : 'TinyCompress';

  const start = $('start');
  $('start-label').textContent = state.active ? 'Pause' : finished ? 'Continue' : 'Start';
  $('start-icon').setAttribute('href', state.active ? '#i-pause' : '#i-play');
  start.disabled = !state.active && !hasPending;
  $('clear').disabled = state.active || busy;
  $('retry').hidden = !counts.failed || state.active;
  $('open').hidden = !counts.done || !backend.canOpenFolder;
  $('zip').hidden = !counts.done;
  document.querySelectorAll('#formats input').forEach((input) => { input.disabled = state.active || busy; });

  $('pick-dest').disabled = Boolean(state.batch);
  $('list-spacer').style.height = `${Math.min(total * rowHeight(), MAX_SPACER_PX)}px`;
  followProgress();
  renderRows();
}

function rowHeight() {
  return Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row'), 10);
}

// How many virtual pixels one real scrolled pixel covers. 1 unless the list is enormous.
function scrollRatio() {
  const list = $('list');
  const full = state.items.length * rowHeight();
  const spacer = Math.min(full, MAX_SPACER_PX);
  const view = list.clientHeight;
  return spacer > view ? (full - view) / (spacer - view) : 1;
}

// Keeps the images being worked on visible until the user scrolls away themselves.
function followProgress() {
  if (!$('follow').checked || !state.working.size) return;
  let lowest = Infinity;
  for (const item of state.working) lowest = Math.min(lowest, item.index);
  const list = $('list');
  const height = rowHeight();
  const target = (Math.max(0, lowest - 1) * height) / scrollRatio();
  if (Math.abs(list.scrollTop - target) > height / 2) list.scrollTo({ top: target, behavior: 'smooth' });
}

// Only on-screen rows exist in the DOM, so the list stays smooth at any size.
// Rows are updated in place rather than rebuilt so their animations keep running.
function renderRows() {
  const list = $('list');
  const height = rowHeight();
  const virtualTop = list.scrollTop * scrollRatio();
  const first = Math.max(0, Math.floor(virtualTop / height) - 3);
  const count = Math.ceil(list.clientHeight / height) + 6;
  const slice = state.items.slice(first, first + count);
  const wanted = new Set(slice.map((item) => item.id));

  for (const [id, row] of state.rows) {
    if (!wanted.has(id)) {
      row.el.remove();
      URL.revokeObjectURL(row.url);
      state.rows.delete(id);
    }
  }

  slice.forEach((item) => {
    let row = state.rows.get(item.id);
    if (!row) {
      row = createRow(item);
      state.rows.set(item.id, row);
      $('list-spacer').append(row.el);
    }
    row.el.style.transform = `translateY(${list.scrollTop + item.index * height - virtualTop}px)`;
    updateRow(row, item);
  });
}

function createRow(item) {
  const el = document.createElement('div');
  el.className = 'row';
  if (item.isNew) {
    el.classList.add('enter');
    item.isNew = false;
  }

  const thumb = document.createElement('button');
  thumb.className = 'thumb';
  thumb.type = 'button';
  thumb.setAttribute('aria-label', `Compare before and after for ${item.rel}`);
  thumb.addEventListener('click', () => {
    if (item.status === 'done') openCompare(item);
  });
  const url = URL.createObjectURL(item.file);
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.src = url;
  img.onerror = () => img.remove();
  thumb.append(img);

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.rel;
  name.title = item.rel;
  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('div');
  fill.className = 'fill';
  track.append(fill);
  const detail = document.createElement('div');
  detail.className = 'detail';
  info.append(name, track, detail);

  const stages = document.createElement('div');
  stages.className = 'stages';

  const outcome = document.createElement('div');
  outcome.className = 'outcome';
  const big = document.createElement('strong');
  const small = document.createElement('small');
  outcome.append(big, small);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  el.append(thumb, info, stages, outcome, actions);
  return { el, url, detail, fill, stages, outcome, big, small, actions, signature: null, actionFor: null, known: new Set() };
}

function updateRow(row, item) {
  let className = `row ${item.status}`;
  if (row.el.classList.contains('enter')) className += ' enter';
  if (item.justFinished) {
    item.justFinished = false;
    row.flashUntil = performance.now() + 1000;
    row.flashClass = item.status === 'done' ? ' done-now' : ' failed-now';
  }
  if (row.flashUntil > performance.now()) className += row.flashClass;
  if (row.el.className !== className) row.el.className = className;

  if (row.detail.textContent !== item.detail) {
    row.detail.textContent = item.detail;
    row.detail.title = item.detail;
    row.detail.classList.remove('enter');
    void row.detail.offsetWidth;
    row.detail.classList.add('enter');
  }
  row.detail.classList.toggle('warn', item.tone === 'warn');
  row.detail.classList.toggle('bad', item.tone === 'bad');
  row.fill.style.transform = `scaleX(${item.status === 'failed' ? 1 : item.progress})`;

  updateOutcome(row, item);
  updateActions(row, item);

  // Rebuilt only when a stage changes, so spinners do not restart on every update.
  const steps = item.steps.length ? item.steps : planSteps(item);
  const signature = steps.map((s) => `${s.id}:${s.state}:${s.size ?? ''}:${s.info ?? ''}`).join('|');
  if (signature !== row.signature) {
    row.signature = signature;
    // With every format on, sizes move to the tooltip so the stages still fit on one line.
    row.stages.classList.toggle('many', steps.length > 4);
    row.stages.replaceChildren(...steps.map((step) => renderStage(row, step)));
  }
}

function updateOutcome(row, item) {
  let big;
  let small;
  switch (item.status) {
    case 'done':
      big = `−${Math.max(0, Math.round((1 - item.smallest / item.inputSize) * 100))}%`;
      small = `${formatSize(item.inputSize)} → ${formatSize(item.smallest)}`;
      break;
    case 'working':
      big = `${Math.round(item.progress * 100)}%`;
      small = formatSize(item.file.size);
      break;
    case 'failed':
      big = 'Failed';
      small = formatSize(item.file.size);
      break;
    default:
      big = 'Queued';
      small = formatSize(item.file.size);
  }
  if (row.big.textContent !== big) row.big.textContent = big;
  if (row.small.textContent !== small) row.small.textContent = small;
  row.outcome.className = `outcome ${item.status}`;
}

function updateActions(row, item) {
  if (row.actionFor === item.status) return;
  row.actionFor = item.status;
  const buttons = [];
  if (item.status === 'done') buttons.push(iconButton('eye', 'Compare before and after', () => openCompare(item)));
  if (item.status === 'failed') buttons.push(iconButton('retry', 'Retry this image', () => retryItem(item)));
  if (item.status === 'pending') buttons.push(iconButton('x', 'Remove from queue', () => removeItem(item)));
  row.actions.replaceChildren(...buttons);
}

function renderStage(row, step) {
  const finished = step.state === 'ok' && step.path;
  const el = document.createElement(finished ? 'a' : 'span');
  el.className = `stage ${step.state}`;
  const key = `${step.id}:${step.state}`;
  if (!row.known.has(key) && step.state !== 'wait') el.classList.add('enter');
  row.known.add(key);
  if (finished) {
    el.href = '#';
    el.addEventListener('click', (event) => {
      event.preventDefault();
      openOutput(step.path);
    });
    el.title = `Open ${step.path}, ${formatSize(step.size)}`;
  }
  const label = document.createElement('b');
  label.textContent = step.label;
  el.append(document.createElement('i'), label);
  const note = step.size !== undefined ? formatSize(step.size) : step.info;
  if (note) {
    const noteEl = document.createElement('em');
    noteEl.textContent = note;
    el.append(noteEl);
  }
  return el;
}

$('list').addEventListener('scroll', () => requestAnimationFrame(renderRows), { passive: true });
for (const type of ['wheel', 'touchmove']) {
  $('list').addEventListener(type, () => { $('follow').checked = false; }, { passive: true });
}
$('list').addEventListener('pointerdown', (event) => {
  if (event.target === $('list')) $('follow').checked = false; // Dragging the scrollbar.
});
window.addEventListener('resize', () => refresh());
$('formats').addEventListener('change', () => {
  scheduleEstimate();
  refresh();
});

window.addEventListener('beforeunload', (event) => {
  if (state.active || backend.hasUnsaved()) event.preventDefault();
});

/* Startup */

(async () => {
  backend = await createBackend();
  $('privacy-text').textContent = backend.privacyText;
  $('save-panel').hidden = backend.mode !== 'cloud';
  $('pick-dest').hidden = !backend.canPickFolder;
  setKeys(await backend.listKeys());
  syncKeyForm();
  render();
  setKeys(await backend.checkKeys());
})();
