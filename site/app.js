// TypeMyFile: everything runs in the browser. No network requests are made
// with the user's file, and nothing is persisted.
//
// Security notes:
// - User text is only ever inserted with textContent (never innerHTML), so a
//   document containing HTML/script can't execute.
// - Files are size-limited and checked by their magic bytes, not just name.
// - pdf.js runs with eval disabled (mitigates CVE-2024-4367-style font attacks)
//   and in a Web Worker served from this origin.
// - The CSP in index.html blocks inline and third-party scripts entirely.

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 2_000_000;        // ~350k words; only the part near the cursor is drawn
const MAX_PDF_PAGES = 3000;

const $ = (id) => document.getElementById(id);
const els = {
  uploadSection: $('upload-section'), gameSection: $('game-section'),
  dropZone: $('drop-zone'), fileInput: $('file-input'), status: $('upload-status'),
  pasteInput: $('paste-input'), pasteGo: $('paste-go'),
  fileName: $('file-name'), passageLabel: $('passage-label'), simplify: $('simplify'),
  wpm: $('stat-wpm'), acc: $('stat-acc'), time: $('stat-time'), progress: $('stat-progress'),
  textBox: $('text-box'), display: $('text-display'), input: $('type-input'), passageSr: $('passage-sr'),
  hint: $('type-hint'), gameNote: $('game-note'), restart: $('btn-restart'), finish: $('btn-finish'), newFile: $('btn-new-file'),
  results: $('results'), resultsHeading: $('results-heading'), resWpm: $('res-wpm'), resRaw: $('res-raw'),
  resAcc: $('res-acc'), resErr: $('res-err'), resTime: $('res-time'), summary: $('session-summary'),
  cont: $('btn-continue'), again: $('btn-again'),
};

/* ---------------- File reading ---------------- */

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function startsWith(bytes, sig) {
  return sig.every((b, i) => bytes[i] === b);
}

function detectType(name, bytes) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';                    // %PDF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && ext === 'docx') return 'docx'; // ZIP
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc'; // OLE2
  if (ext === 'txt') return 'txt';
  return null;
}

async function readTxt(buffer) {
  // Try strict UTF-8 first, fall back to Windows-1252 for older files.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

async function readPdf(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  }).promise;
  try {
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let out = '';
    for (let i = 1; i <= pages && out.length < MAX_TEXT_CHARS; i++) {
      setStatus(`Reading PDF page ${i} of ${pages}…`);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('') + '\n\n';
      page.cleanup();
    }
    return out;
  } finally {
    pdf.destroy();
  }
}

async function readDocx(buffer) {
  if (!window.mammoth) throw new Error('The Word reader failed to load. Please refresh the page.');
  const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

// Legacy binary .doc (Word 97–2003) has no small, safe browser parser, so we
// pull out runs of readable text. Works for most simple documents; we warn the
// user that saving as .docx gives better results.
function readLegacyDoc(buffer) {
  const bytes = new Uint8Array(buffer);
  const MIN_RUN = 12;
  const isPrintable = (c) => (c >= 0x20 && c < 0x7f) || c === 0x0d || c === 0x0a || c === 0x09 || (c >= 0xa0 && c <= 0xff);

  const collect = (step) => {
    const runs = [];
    let cur = '';
    for (let i = 0; i + step - 1 < bytes.length; i += step) {
      const c = bytes[i];
      const ok = isPrintable(c) && (step === 1 || bytes[i + 1] === 0);
      if (ok) cur += String.fromCharCode(c);
      else {
        if (cur.length >= MIN_RUN && /[a-z]{3,}\s+[a-z]{2,}/i.test(cur)) runs.push(cur);
        cur = '';
      }
    }
    if (cur.length >= MIN_RUN) runs.push(cur);
    return runs.join('\n');
  };

  const utf16 = collect(2);
  const ansi = collect(1);
  const text = utf16.length > ansi.length * 0.6 ? utf16 : ansi;
  // Drop common style/font-table noise.
  return text
    .split('\n')
    .filter((l) => !/^(Times New Roman|Arial|Calibri|Symbol|Normal|Default Paragraph Font|Microsoft Word|Root Entry|WordDocument|SummaryInformation)/i.test(l.trim()))
    .join('\n');
}

async function handleFile(file) {
  if (!file) return;
  if (file.size === 0) return setStatus('That file is empty.', true);
  if (file.size > MAX_FILE_BYTES) return setStatus('That file is larger than 10 MB. Please choose a smaller file.', true);

  setStatus('Reading file…');
  try {
    const buffer = await file.arrayBuffer();
    const type = detectType(file.name, new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength)));
    let text;
    let note = '';
    switch (type) {
      case 'txt': text = await readTxt(buffer); break;
      case 'pdf': text = await readPdf(buffer); break;
      case 'docx': text = await readDocx(buffer); break;
      case 'doc':
        text = readLegacyDoc(buffer);
        note = ' Older .doc files are read on a best-effort basis; for cleaner text, save it as .docx.';
        break;
      default:
        return setStatus('Unsupported file. Please use .txt, .pdf, .docx or .doc.', true);
    }
    loadText(text, file.name, note);
  } catch (err) {
    console.error(err);
    const msg = err && err.name === 'PasswordException'
      ? 'That PDF is password-protected.'
      : 'Sorry, that file could not be read. It may be damaged or in an unsupported format.';
    setStatus(msg, true);
  }
}

/* ---------------- Text preparation ---------------- */

// Character classes are built from numeric code points so the source stays plain ASCII.
const fromCodes = (codes) => codes.map((c) => (Array.isArray(c)
  ? String.fromCharCode(c[0]) + '-' + String.fromCharCode(c[1])
  : String.fromCharCode(c))).join('');
const charClass = (...codes) => new RegExp('[' + fromCodes(codes) + ']', 'g');

const RE_CONTROL = charClass([0x00, 0x08], 0x0B, 0x0C, [0x0E, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F], 0x2028, 0x2029, 0x2060, 0xFEFF);
const RE_SOFT_HYPHEN = new RegExp(String.fromCharCode(0xAD) + '\\s*', 'g'); // invisible line-break hyphen
const SINGLE_QUOTES = [0x2018, 0x2019, 0x201A, 0x201B, 0x2032, 0x02BC, 0xFF07];
const DOUBLE_QUOTES = [0x201C, 0x201D, 0x201E, 0x201F, 0x2033, 0x00AB, 0x00BB, 0xFF02];
const DASHES = [[0x2010, 0x2015], 0x2212, 0xFE58, 0xFE63, 0xFF0D];
const SPACES = [0x00A0, [0x2000, 0x200A], 0x202F, 0x205F, 0x3000];
const RE_SINGLE_QUOTES = charClass(...SINGLE_QUOTES);
const RE_DOUBLE_QUOTES = charClass(...DOUBLE_QUOTES);
const RE_DASHES = charClass(...DASHES);
const RE_SPACES = charClass(...SPACES);
const RE_BULLETS = charClass(0x2022, 0x2023, 0x2043, 0x25A0, 0x25AA, 0x25CF, 0x25E6);
const ELLIPSIS = String.fromCharCode(0x2026);
// Emoji and other characters outside the Basic Multilingual Plane can't be typed on a normal
// keyboard, and dropping them keeps one character = one string index.
const RE_ASTRAL = charClass([0xD800, 0xDFFF]);

// Look-alike characters the player can type with the plain key, even when
// "Simplify punctuation" is off.
const EQUIVALENT = new Map();
for (const [codes, plain] of [[SINGLE_QUOTES, "'"], [DOUBLE_QUOTES, '"'], [DASHES, '-'], [SPACES, ' ']]) {
  for (const c of codes) {
    const [from, to] = Array.isArray(c) ? c : [c, c];
    for (let i = from; i <= to; i++) EQUIVALENT.set(String.fromCharCode(i), plain);
  }
}
const canon = (c) => EQUIVALENT.get(c) || c;
const matches = (typed, target) => typed === target || canon(typed) === canon(target);

function cleanText(raw, simplify) {
  let t = String(raw).slice(0, MAX_TEXT_CHARS);
  // Strip control characters (keep normal whitespace) and zero-width chars.
  t = t.replace(RE_CONTROL, ' ').replace(RE_SOFT_HYPHEN, '');
  t = t.normalize('NFC').replace(RE_ASTRAL, '');
  // Re-join words hyphenated across line breaks (common in PDFs).
  t = t.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');
  if (simplify) {
    t = t
      .replace(RE_SINGLE_QUOTES, "'")
      .replace(RE_DOUBLE_QUOTES, '"')
      .replace(RE_DASHES, '-')
      .replaceAll(ELLIPSIS, '...')
      .replace(RE_SPACES, ' ')
      .replace(RE_BULLETS, '-');
  }
  // One line of text: collapse all whitespace to single spaces.
  return t.replace(/\s+/g, ' ').trim();
}

/* ---------------- Game state ---------------- */

const LOOKAHEAD = 1500;      // always keep at least this many characters drawn ahead of the cursor
const RENDER_CHUNK = 2000;   // characters added to the page at a time
const IDLE_PAUSE_MS = 5000;  // pause the clock after this long without a keystroke

const state = {
  rawText: '',
  target: '',        // the whole cleaned document
  wordCount: 0,
  ok: new Uint8Array(0), // 1 where the typed character matches
  rendered: 0,       // how many characters have spans on the page
  value: '',         // what was in the input last time we looked
  correctChars: 0,
  keystrokes: 0,
  correctKeystrokes: 0,
  elapsed: 0,        // ms of active typing before the current stretch
  segStart: 0,       // start of the current typing stretch (0 = clock paused)
  lastKey: 0,
  timerId: 0,
  lineTop: -1,
  finished: false,
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function loadText(raw, name, note = '') {
  const cleaned = cleanText(raw, els.simplify.checked);
  if (cleaned.split(' ').length < 3) {
    return setStatus("We couldn't find enough readable text in that file. (Scanned PDFs that are only images can't be read.)", true);
  }
  state.rawText = raw;
  if (String(raw).length > MAX_TEXT_CHARS) {
    note += ` This file is very long, so only the first ${MAX_TEXT_CHARS.toLocaleString()} characters were loaded.`;
  }
  setStatus('');
  els.gameNote.textContent = note.trim();
  els.gameNote.hidden = !note.trim();
  els.fileName.textContent = name;
  els.uploadSection.hidden = true;
  els.gameSection.hidden = false;
  startGame();
}

function startGame() {
  stopTimer();
  state.target = cleanText(state.rawText, els.simplify.checked);
  state.wordCount = state.target.split(' ').length;
  state.ok = new Uint8Array(state.target.length);
  state.rendered = 0;
  state.value = '';
  state.correctChars = 0;
  state.keystrokes = 0;
  state.correctKeystrokes = 0;
  state.elapsed = 0;
  state.segStart = 0;
  state.lastKey = 0;
  state.lineTop = -1;
  state.finished = false;

  els.display.replaceChildren();
  els.passageSr.textContent = state.target;
  els.passageLabel.textContent = `· ${state.wordCount.toLocaleString()} words`;
  els.input.value = '';
  els.input.maxLength = state.target.length;
  els.input.disabled = false;
  els.results.hidden = true;
  els.finish.disabled = false;
  setHint('Click the text and start typing. The timer starts on your first key and pauses when you stop.');

  renderUntil(LOOKAHEAD + RENDER_CHUNK);
  els.textBox.scrollTop = 0;
  updateStats();
  els.input.focus({ preventScroll: true });
}

function setHint(text) {
  els.hint.textContent = text;
}

/* ---------------- Rendering (only slightly ahead of the player) ---------------- */

function classFor(i) {
  const typed = state.value.length;
  if (i < typed) return state.ok[i] ? 'ch ok' : 'ch bad';
  return i === typed ? 'ch cur' : 'ch';
}

function renderUntil(n) {
  const end = Math.min(n, state.target.length);
  if (state.rendered >= end) return;
  // Build with DOM nodes + textContent only — never innerHTML with user data.
  const frag = document.createDocumentFragment();
  while (state.rendered < end) {
    const stop = Math.min(state.rendered + RENDER_CHUNK, state.target.length);
    for (let i = state.rendered; i < stop; i++) {
      const span = document.createElement('span');
      span.className = classFor(i);
      span.textContent = state.target[i];
      frag.appendChild(span);
    }
    state.rendered = stop;
  }
  els.display.appendChild(frag);
}

function paint(from, to) {
  const spans = els.display.children;
  const last = Math.min(to, state.rendered - 1);
  for (let i = Math.max(0, from); i <= last; i++) {
    const cls = classFor(i);
    if (spans[i].className !== cls) spans[i].className = cls;
  }
}

// Scroll so the current line sits about a third of the way down the box.
function keepCursorInView(force = false) {
  const spans = els.display.children;
  const cur = spans[Math.min(state.value.length, spans.length - 1)];
  if (!cur) return;
  const top = cur.offsetTop;
  if (!force && top === state.lineTop) return;
  state.lineTop = top;
  const box = els.textBox;
  const dest = Math.max(0, top - box.clientHeight / 3);
  // Glide one line at a time; jump straight there if the cursor is far away.
  const far = Math.abs(dest - box.scrollTop) > box.clientHeight;
  box.scrollTo({ top: dest, behavior: reduceMotion.matches || far ? 'auto' : 'smooth' });
}

/* ---------------- Timing ---------------- */

function elapsedMs() {
  return state.elapsed + (state.segStart ? performance.now() - state.segStart : 0);
}

function resumeClock() {
  if (!state.segStart) state.segStart = performance.now();
  if (!state.timerId) state.timerId = setInterval(tick, 250);
  setHint('Typing… the timer pauses if you stop for 5 seconds.');
}

function pauseClock(at = performance.now()) {
  if (state.segStart) {
    state.elapsed += Math.max(0, at - state.segStart);
    state.segStart = 0;
  }
  if (state.value.length && !state.finished) setHint('Paused. Start typing to continue.');
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = 0;
}

function tick() {
  // Idle time doesn't count against your speed.
  if (state.segStart && performance.now() - state.lastKey > IDLE_PAUSE_MS) pauseClock(state.lastKey);
  updateStats();
}

/* ---------------- Stats ---------------- */

function computeStats() {
  const typed = state.value.length;
  const ms = elapsedMs();
  // Treat anything under a second as one second so the first keystrokes don't show absurd speeds.
  const minutes = typed ? Math.max(ms, 1000) / 60000 : 0;
  return {
    typed,
    errors: typed - state.correctChars,
    net: minutes ? state.correctChars / 5 / minutes : 0,
    raw: minutes ? typed / 5 / minutes : 0,
    acc: state.keystrokes ? (state.correctKeystrokes / state.keystrokes) * 100 : 100,
    ms,
  };
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtProgress(typed) {
  const pct = state.target.length ? (typed / state.target.length) * 100 : 0;
  return state.target.length > 2000 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

function updateStats() {
  const s = computeStats();
  els.wpm.textContent = Math.round(s.net);
  els.acc.textContent = `${Math.round(s.acc)}%`;
  els.time.textContent = fmtTime(s.ms);
  els.progress.textContent = fmtProgress(s.typed);
}

/* ---------------- Input ---------------- */

function onInput() {
  if (state.finished) return;
  const val = els.input.value;
  const old = state.value;

  // The caret is locked to the end, so edits normally only happen at the end.
  // Find where the old and new text start to differ (fast path first).
  let p = Math.min(old.length, val.length);
  if (old.slice(0, p) !== val.slice(0, p)) {
    p = 0;
    while (old[p] === val[p]) p++;
  }

  // Re-score from the first changed character onward.
  for (let i = p; i < old.length; i++) if (state.ok[i]) state.correctChars--;
  for (let i = p; i < val.length; i++) {
    const good = matches(val[i], state.target[i]);
    state.ok[i] = good ? 1 : 0;
    if (good) state.correctChars++;
    // Every newly typed character is a keystroke; backspacing doesn't erase past mistakes from accuracy.
    if (i >= old.length || val[i] !== old[i]) {
      state.keystrokes++;
      if (good) state.correctKeystrokes++;
    }
  }
  state.value = val;

  if (val.length) {
    state.lastKey = performance.now();
    resumeClock();
  }

  renderUntil(val.length + LOOKAHEAD);
  paint(p, Math.max(old.length, val.length));
  keepCursorInView();
  updateStats();
  if (val.length >= state.target.length) finish(true);
}

function caretToEnd() {
  const n = els.input.value.length;
  if (els.input.selectionStart !== n || els.input.selectionEnd !== n) els.input.setSelectionRange(n, n);
}

const BLOCKED_KEYS = new Set(['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/* ---------------- Results ---------------- */

function finish(completed) {
  pauseClock();
  stopTimer();
  state.finished = true;
  els.input.disabled = true;
  els.finish.disabled = true;
  const s = computeStats();
  els.resultsHeading.textContent = completed ? 'You finished the whole file!' : 'Your results so far';
  els.resWpm.textContent = Math.round(s.net);
  els.resRaw.textContent = Math.round(s.raw);
  els.resAcc.textContent = `${s.acc.toFixed(1)}%`;
  els.resErr.textContent = s.errors;
  els.resTime.textContent = fmtTime(s.ms);
  const typedWords = state.target.slice(0, s.typed).split(' ').filter(Boolean).length;
  els.summary.textContent = `You typed ${typedWords.toLocaleString()} of ${state.wordCount.toLocaleString()} words (${fmtProgress(s.typed)}).`;
  els.cont.hidden = completed;
  els.results.hidden = false;
  setHint('');
  els.results.focus();
}

function keepGoing() {
  state.finished = false;
  els.input.disabled = false;
  els.finish.disabled = false;
  els.results.hidden = true;
  setHint('Paused. Start typing to continue.');
  els.input.focus({ preventScroll: true });
  caretToEnd();
  keepCursorInView(true);
}

/* ---------------- Events ---------------- */

els.fileInput.addEventListener('change', () => {
  handleFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((ev) => els.dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropZone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => els.dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('drag');
}));
els.dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
// Stop the browser from navigating to a file dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.pasteGo.addEventListener('click', () => {
  const text = els.pasteInput.value;
  if (!text.trim()) return setStatus('Paste some text first.', true);
  loadText(text, 'Pasted text');
});

els.input.addEventListener('input', onInput);
['paste', 'drop', 'cut'].forEach((ev) => els.input.addEventListener(ev, (e) => e.preventDefault()));
els.input.addEventListener('keydown', (e) => {
  // Keep the caret at the end: no moving around or selecting the hidden text.
  if (BLOCKED_KEYS.has(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) e.preventDefault();
});
['select', 'click', 'focus'].forEach((ev) => els.input.addEventListener(ev, caretToEnd));
els.input.addEventListener('focus', () => els.textBox.classList.add('focused'));
els.input.addEventListener('blur', () => {
  els.textBox.classList.remove('focused');
  pauseClock();
});
els.textBox.addEventListener('click', () => {
  if (!state.finished) els.input.focus({ preventScroll: true });
  keepCursorInView(true);
});

els.restart.addEventListener('click', startGame);
els.again.addEventListener('click', startGame);
els.finish.addEventListener('click', () => finish(false));
els.cont.addEventListener('click', keepGoing);

els.simplify.addEventListener('change', () => {
  if (!state.rawText) return;
  if (state.value.length && !window.confirm('Changing this setting starts the file over from the beginning. Continue?')) {
    els.simplify.checked = !els.simplify.checked;
    return;
  }
  startGame();
});

els.newFile.addEventListener('click', () => {
  if (state.value.length && !state.finished && !window.confirm('Leave this file? Your progress will be lost.')) return;
  pauseClock();
  stopTimer();
  state.rawText = '';
  state.target = '';
  state.value = '';
  els.display.replaceChildren();
  els.passageSr.textContent = '';
  els.gameSection.hidden = true;
  els.uploadSection.hidden = false;
  setStatus('');
  els.fileInput.focus();
});
