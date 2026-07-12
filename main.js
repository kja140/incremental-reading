'use strict';

const {
  Plugin, Notice, Modal, FuzzySuggestModal, TFile, parseYaml, FileSystemAdapter,
  PluginSettingTab, Setting, ItemView, normalizePath,
} = require('obsidian');
// Obsidian's plugin loader evaluates this file without a resolvable __dirname, so
// `require('./tree-core.js')` fails ("Cannot find module"). The tree logic is therefore
// inlined here verbatim. tree-core.js remains the unit-tested source of truth; the block
// between the markers below MUST stay byte-identical to it (enforced by test/inline-sync.test.js).
const treeCore = (function () {
// >>> tree-core-functions (verbatim-shared with main.js; drift-checked by test/inline-sync.test.js)
// Extract the target basename from a wikilink value. Strips #headings and |aliases.
// Intentional: if value is not a wikilink, it is returned as-is — frontmatter may store a plain basename.
function linkTargetName(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/\[\[([^\]\|#]+)(?:[#\|][^\]]*)?\]\]/);
  const name = (m ? m[1] : s).trim();
  return name || null;
}

// Effective parent NAME: explicit root wins, then `parent`, then `source` (legacy fallback).
function effectiveParent(fm) {
  if (!fm) return null;
  if (fm.tree_root === true) return null;
  return linkTargetName(fm.parent) || linkTargetName(fm.source) || null;
}

// Comparator: tree_order ascending (missing = Infinity), then basename.
function siblingComparator(a, b) {
  const an = Number(a.fm && a.fm.tree_order);
  const bn = Number(b.fm && b.fm.tree_order);
  const ao = Number.isFinite(an) ? an : Infinity;
  const bo = Number.isFinite(bn) ? bn : Infinity;
  if (ao !== bo) return ao - bo;
  return a.basename.localeCompare(b.basename);
}

// Build index: { byName: Map<lowerBasename,page>, childrenOf: Map<lowerParent,page[]>, roots: page[] }.
// A page is a root when it has no effective parent OR its parent target is absent (dangling).
function buildTreeIndex(pages) {
  const byName = new Map();
  const duplicates = new Set();
  for (const p of pages) {
    const key = p.basename.toLowerCase();
    if (byName.has(key)) duplicates.add(key);
    else byName.set(key, p);
  }
  const childrenOf = new Map();
  const roots = [];
  for (const p of pages) {
    const parentName = effectiveParent(p.fm);
    const key = parentName ? parentName.toLowerCase() : null;
    if (key && byName.has(key) && !duplicates.has(key)) {
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(p);
    } else {
      roots.push(p);
    }
  }
  const cmp = siblingComparator;
  roots.sort(cmp);
  for (const arr of childrenOf.values()) arr.sort(cmp);
  return { pages: pages.slice(), byName, childrenOf, roots, duplicates };
}

// True if moving `childName` under `newParentName` would create a cycle.
// Walks UP from newParentName via effective parents; cycle if childName is reached.
function wouldCreateCycle(index, childName, newParentName) {
  if (!newParentName) return false;
  const child = childName.toLowerCase();
  let cur = newParentName.toLowerCase();
  const seen = new Set();
  while (cur) {
    if (cur === child) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    const page = index.byName.get(cur);
    if (!page) break;
    const up = effectiveParent(page.fm);
    cur = up ? up.toLowerCase() : null;
  }
  return false;
}

// Given current sibling display order [{path, tree_order?}], move `movedPath` to
// targetIndex and renumber all with gap-10 spacing. Returns only changed entries.
function computeReorder(siblings, movedPath, targetIndex) {
  const moved = siblings.find(s => s.path === movedPath);
  if (!moved) return [];
  const rest = siblings.filter(s => s.path !== movedPath);
  const idx = Math.max(0, Math.min(targetIndex, rest.length));
  rest.splice(idx, 0, moved);
  const writes = [];
  rest.forEach((s, i) => {
    const want = (i + 1) * 10;
    if (Number(s.tree_order) !== want) writes.push({ path: s.path, tree_order: want });
  });
  return writes;
}
// <<< tree-core-functions
  return { linkTargetName, effectiveParent, siblingComparator, buildTreeIndex, wouldCreateCycle, computeReorder };
})();

const spacedRepetitionCore = (function () {
// >>> spaced-repetition-core-functions
function nativeCardText(value) {
  return String(value ?? '').trim().replace(/\r/g, '').replace(/\n[ \t]*\n+/g, '\n<br>\n');
}

function spacedRepetitionBody(format, question, answer, settings = {}) {
  const q = nativeCardText(question);
  const a = nativeCardText(answer);
  if (format === 'cloze') return q + '\n';
  const separator = format === 'reverse'
    ? (settings.multilineReversedCardSeparator || '??')
    : (settings.multilineCardSeparator || '?');
  return `${q}\n${separator}\n${a}\n`;
}
// <<< spaced-repetition-core-functions
  return { nativeCardText, spacedRepetitionBody };
})();

const dateCore = (function () {
// >>> date-core-functions
const SUPPORTED_DATE_FORMATS = ['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'];

function normalizeDateFormat(format) {
  return SUPPORTED_DATE_FORMATS.includes(format) ? format : 'DD-MM-YYYY';
}

function parseDateExact(value, format = 'DD-MM-YYYY') {
  if (!value) return null;
  const normalized = normalizeDateFormat(format);
  const match = String(value).trim().match(/^(\d{2}|\d{4})-(\d{2})-(\d{2}|\d{4})$/);
  if (!match) return null;
  const parts = String(value).trim().split('-').map(Number);
  let day, month, year;
  if (normalized === 'DD-MM-YYYY') [day, month, year] = parts;
  else if (normalized === 'MM-DD-YYYY') [month, day, year] = parts;
  else [year, month, day] = parts;
  if (year < 1000 || day < 1 || month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function parseDate(value, preferredFormat = 'DD-MM-YYYY') {
  const preferred = normalizeDateFormat(preferredFormat);
  for (const format of [preferred, ...SUPPORTED_DATE_FORMATS.filter(f => f !== preferred)]) {
    const parsed = parseDateExact(value, format);
    if (parsed) return parsed;
  }
  return null;
}

function formatDate(date, format = 'DD-MM-YYYY') {
  const normalized = normalizeDateFormat(format);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).padStart(4, '0');
  if (normalized === 'MM-DD-YYYY') return `${month}-${day}-${year}`;
  if (normalized === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
  return `${day}-${month}-${year}`;
}

function reformatDate(value, fromFormat, toFormat) {
  const parsed = parseDateExact(value, fromFormat);
  return parsed ? formatDate(parsed, toFormat) : value;
}
// <<< date-core-functions
  return { SUPPORTED_DATE_FORMATS, normalizeDateFormat, parseDateExact, parseDate, formatDate, reformatDate };
})();

const topicCore = (function () {
// >>> topic-core-functions
function progressAwareAFactor(fm, settings, overrides = {}) {
  const s = settings.scheduling;
  let remaining = null;
  const pageTarget = Number(fm.page_end) > 0 ? Number(fm.page_end) : Number(fm.total_pages);
  const readPoint = overrides.readPoint ?? fm.read_point;
  const readSeconds = overrides.readPointSeconds ?? fm.read_point_seconds;
  if (pageTarget > 0) {
    const read = Math.max(0, Math.min(Number(readPoint) || 0, pageTarget));
    remaining = Math.max(1, pageTarget - read);
  } else if (Number(fm.total_seconds) > 0) {
    const read = Math.max(0, Math.min(Number(readSeconds) || 0, Number(fm.total_seconds)));
    remaining = Math.max(1, (Number(fm.total_seconds) - read) / 60);
  }
  if (remaining == null) return null;
  const af = s.initial_af_base - s.initial_af_slope * Math.log2(remaining / s.initial_af_units_divisor);
  return Math.max(s.a_factor_min, Math.min(s.a_factor_max, af));
}

function hasProgressAdvanced({
  previousPage = 0,
  nextPage = 0,
  previousSeconds = 0,
  nextSeconds = 0,
  previousLine = 0,
  nextLine = 0,
} = {}) {
  return Number(nextPage) > Number(previousPage)
    || Number(nextSeconds) > Number(previousSeconds)
    || Number(nextLine) > Number(previousLine);
}
// <<< topic-core-functions
  return { progressAwareAFactor, hasProgressAdvanced };
})();

// ============================================================================
//  Constants
// ============================================================================

const ROOT = 'Sources/Incremental Reading';
const SOURCES_FOLDER = `${ROOT}/Sources`;
const EXTRACTS_FOLDER = `${ROOT}/Extracts`;
const CARDS_FOLDER = `${ROOT}/Cards`;
const ATTACHMENTS_FOLDER = `${ROOT}/Attachments`;
const CATEGORIES_FOLDER = `${ROOT}/Categories`;
const KNOWLEDGE_TREE_VIEW_TYPE = 'ir-tree-view';
const KNOWLEDGE_TREE_SIDEBAR_TYPE = 'ir-tree-sidebar';
const REVIEW_LOG_PATH = `${ROOT}/Review Log.md`;
const DASHBOARD_PATH = `${ROOT}/Incremental-Reading-Dashboard.md`;
const SPACED_REPETITION_PLUGIN_ID = 'obsidian-spaced-repetition';
const SPACED_REPETITION_REVIEW_COMMAND = `${SPACED_REPETITION_PLUGIN_ID}:srs-review-flashcards`;
const SPACED_REPETITION_NOTE_COMMAND = `${SPACED_REPETITION_PLUGIN_ID}:srs-review-flashcards-in-note`;

const READ_POINT_MARKER = '📍<!--ir-readpoint-->';
const READ_POINT_RE = /(?:📍\s*)?<!--ir-readpoint-->/g;
const BODY_MARKER = '<!--ir-card-body-->';
// ==highlight== cloze marker. Inner allows single '=' (LaTeX like ==E = mc^2==)
// but not '==', so the closing delimiter is never swallowed. Build per-use with
// `new RegExp(HL_CLOZE_SRC, 'g')` — shared lastIndex across call sites would corrupt matchAll/replace.
const HL_CLOZE_SRC = '==((?:[^=]|=(?!=))+)==';


// ============================================================================
//  Default settings — single source of truth for tunables.
// ============================================================================

const DEFAULT_SETTINGS = {
  scheduling: {
    a_factor_min: 1.05,
    a_factor_max: 5.0,
    progress_aware: true,
    stall_guard: true,
    quality_hold: 1.0,
    quality_speed_up: 0.95,
    quality_slow_down: 1.05,
    initial_af_base: 2.5,
    initial_af_slope: 0.25,
    initial_af_units_divisor: 10,
    extract_bump: 1.05,
  },
  queue: {
    sidebar_enabled: true,
    default_tag_filter: '',
    sort_key: 'urgency',
  },
  inline_cards: {
    enabled: true,
    qa_regex: '^Q::\\s*(.+?)\\s*::A::\\s*(.+)$',
    cloze_regex: '\\{\\{c(\\d+)::([^}]+?)(?:::([^}]+?))?\\}\\}',
  },
  spaced_repetition: {
    flashcardTag: 'flashcards/incremental-reading',
    multilineCardSeparator: '?',
    multilineReversedCardSeparator: '??',
  },
  paths: {
    sources: 'Sources/Incremental Reading/Sources',
    extracts: 'Sources/Incremental Reading/Extracts',
    cards: 'Sources/Incremental Reading/Cards',
    review_log: 'Sources/Incremental Reading/Review Log.md',
    sioyek: '/Applications/sioyek.app/Contents/MacOS/sioyek',
  },
  misc: {
    debug: false,
    date_format: 'DD-MM-YYYY',
  },
  tree: {
    expanded: [],
    child_warn_threshold: 100,
  },
};

//  Date helpers
// ============================================================================

function configuredDateFormat(settings) {
  return dateCore.normalizeDateFormat(settings?.misc?.date_format);
}

function parseDateValue(value, settings) {
  return dateCore.parseDate(value, configuredDateFormat(settings));
}

function formatDateValue(date, settings) {
  return dateCore.formatDate(date, configuredDateFormat(settings));
}

function todayDateString(settings) { return formatDateValue(todayDate(), settings); }

function todayDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function futureDateString(days, settings) {
  const d = todayDate();
  d.setDate(d.getDate() + days);
  return formatDateValue(d, settings);
}

function daysBetween(a, b) {
  return Math.round((a - b) / 86400000);
}

// ============================================================================
//  Scoring helpers
// ============================================================================

function priorityToInterval(priority) {
  const p = Math.min(Math.max(Number(priority) || 50, 1), 100);
  return Math.max(1, Math.ceil(p * 0.15));
}

function urgency(fm, today, settings) {
  const pri = fm.priority ? (101 - fm.priority) * 10 : 0;
  const nr = parseDateValue(fm.next_review, settings);
  if (!nr) return pri;
  const diff = daysBetween(today, nr);
  let u = pri + diff * 2;
  if (diff >= 0) u += 5000;
  return u;
}

function isDue(fm, today, settings) {
  if (!fm.next_review) return true;
  const nr = parseDateValue(fm.next_review, settings);
  if (!nr) return true;
  return nr <= today;
}

function isPastDue(fm, today, settings) {
  if (!fm.next_review) return false;
  const nr = parseDateValue(fm.next_review, settings);
  if (!nr) return false;
  return nr < today;
}

function isActiveIR(fm) {
  if (!fm) return false;
  if (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card') return false;
  if (fm.status === 'done' || fm.status === 'container' ||
      fm.status === 'dismissed' || fm.status === 'inbox') return false;
  return true;
}

// ============================================================================
//  A-Factor (topic scheduling) — progress-aware
// ============================================================================
//  Per-rep recompute from the *remaining* material so long unfinished sources
//  stay in active rotation (small a_factor) and short almost-done sources
//  exit quickly (large a_factor). Falls back to a static a_factor when the
//  file has no page/seconds metadata.

function clampAFactor(settings, x) {
  const s = settings.scheduling;
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 1) return s.a_factor_min;
  return Math.max(s.a_factor_min, Math.min(s.a_factor_max, n));
}

function readAFactor(settings, fm) {
  return clampAFactor(settings, fm?.a_factor);
}

function initialAFactor(settings, { total_pages, total_seconds } = {}) {
  const s = settings.scheduling;
  let units = null;
  if (Number(total_pages) > 0) units = Number(total_pages);
  else if (Number(total_seconds) > 0) units = Number(total_seconds) / 60;
  if (!units || units < 1) return 2.0;
  const af = s.initial_af_base - s.initial_af_slope * Math.log2(units / s.initial_af_units_divisor);
  return Math.max(s.a_factor_min, Math.min(2.5, af));
}

// ============================================================================
const round4 = (x) => Math.round(x * 10000) / 10000;

//  Link parsing
// ============================================================================

function linkTarget(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/);
  return m ? m[1].trim() : s.trim();
}

function linkPointsTo(value, target) {
  const t = linkTarget(value);
  return t === target;
}

// ============================================================================
//  Inline cards — parse Q::A / cloze / {{c1::...}} forms out of a note body.
//  Each match yields a stable id so repeated exports can avoid duplicates.
// ============================================================================

function inlineCardId(filePath, literal) {
  let h = 0x811c9dc5;
  const s = `${filePath}\n${literal}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function parseInlineCards(filePath, body, settings) {
  const s = settings.inline_cards;
  if (!s.enabled) return [];
  const lines = body.split('\n');
  const out = [];

  const qa = new RegExp(s.qa_regex);
  const cloze = new RegExp(s.cloze_regex, 'g');

  // The same literal (e.g. `==voltage angle==`) on two lines hashes to the same
  // id, colliding so only one card is gradable and the other sticks in the queue.
  // Salt repeats with `#2`, `#3`… The first occurrence keeps the plain hash, so
  // ids for unique literals stay backward-compatible with existing review state.
  const seen = new Set();
  const uniqId = (literal) => {
    let id = inlineCardId(filePath, literal);
    let n = 1;
    while (seen.has(id)) id = inlineCardId(filePath, `${literal}#${++n}`);
    seen.add(id);
    return id;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(qa);
    if (m) {
      out.push({
        id: uniqId(m[0]),
        line: i,
        type: 'qa',
        question: m[1],
        answer: m[2],
      });
      continue;
    }
    for (const cm of line.matchAll(cloze)) {
      out.push({
        id: uniqId(cm[0]),
        line: i,
        type: 'cloze',
        cloze_index: Number(cm[1]),
        text: cm[2],
        hint: cm[3] || null,
        full_line: line,
      });
    }
    for (const hm of line.matchAll(new RegExp(HL_CLOZE_SRC, 'g'))) {
      out.push({
        id: uniqId(hm[0]),
        line: i,
        type: 'cloze',
        cloze_index: 1,
        text: hm[1],
        hint: null,
        full_line: line,
      });
    }
  }
  return out;
}

//  Modal helpers
// ============================================================================

class TextPromptModal extends Modal {
  constructor(app, title, defaultValue, resolve) {
    super(app);
    this.title = title;
    this.defaultValue = defaultValue ?? '';
    this.resolve = resolve;
    this._resolved = false;
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    const input = contentEl.createEl('input', { cls: 'ir-modal-input' });
    input.type = 'text';
    input.value = this.defaultValue;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._submit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); this._cancel(); }
    });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const submit = row.createEl('button', { text: 'OK', cls: 'mod-cta' });
    submit.addEventListener('click', () => this._submit(input.value));
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this._cancel());
    // Defer focus a tick so any closing modal above us releases focus first.
    window.setTimeout(() => { input.focus(); input.select(); }, 20);
  }
  _submit(v) {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(v);
  }
  _cancel() {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(null);
  }
  onClose() {
    this.contentEl.empty();
    if (!this._resolved) {
      this._resolved = true;
      this.resolve(null);
    }
  }
}

class GenericSuggestModal extends FuzzySuggestModal {
  constructor(app, items, displayFn, resolve, placeholder) {
    super(app);
    this.items = items;
    this.displayFn = displayFn;
    this.resolve = resolve;
    this._chose = false;
    this._chosen = null;
    this._resolved = false;
    if (placeholder) this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(i) { return this.displayFn(i); }
  // Resolve immediately on selection. Earlier "defer to onClose" was a
  // workaround for chained-modal focus loss, but evidence shows Obsidian
  // calls `close()` synchronously after `onChooseItem`, so by the time the
  // promise consumer runs, the modal is already gone.
  onChooseItem(i, evt) {
    if (this._resolved) return;
    this._resolved = true;
    this.resolve(i);
  }
  onClose() {
    super.onClose?.();
    // Obsidian fires `close()` BEFORE `onChooseItem` in current builds, so
    // we can't resolve null here directly — onChooseItem fires immediately
    // after and would arrive too late. Defer the cancel-resolve so a real
    // selection has time to land first.
    setTimeout(() => {
      if (this._resolved) return;
      this._resolved = true;
      this.resolve(null);
    }, 50);
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, resolve) {
    super(app);
    this.title = title;
    this.message = message;
    this.resolve = resolve;
    this._resolved = false;
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    if (this.message) contentEl.createEl('p', { text: this.message });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const yes = row.createEl('button', { text: 'OK', cls: 'mod-cta' });
    yes.addEventListener('click', () => this._answer(true));
    const no = row.createEl('button', { text: 'Cancel' });
    no.addEventListener('click', () => this._answer(false));
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._answer(true); }
      else if (e.key === 'Escape') { e.preventDefault(); this._answer(false); }
    };
    contentEl.addEventListener('keydown', onKey);
    window.setTimeout(() => yes.focus(), 20);
  }
  _answer(v) {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(v);
  }
  onClose() {
    this.contentEl.empty();
    if (!this._resolved) {
      this._resolved = true;
      this.resolve(false);
    }
  }
}

class LongTextModal extends Modal {
  constructor(app, title, defaultValue, resolve) {
    super(app);
    this.title = title;
    this.defaultValue = defaultValue ?? '';
    this.resolve = resolve;
    this._resolved = false;
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    const ta = contentEl.createEl('textarea', { cls: 'ir-modal-textarea' });
    ta.value = this.defaultValue;
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const submit = row.createEl('button', { text: 'OK', cls: 'mod-cta' });
    submit.addEventListener('click', () => this._submit(ta.value));
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this._cancel());
    window.setTimeout(() => ta.focus(), 20);
  }
  _submit(v) {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(v);
  }
  _cancel() {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(null);
  }
  onClose() {
    this.contentEl.empty();
    if (!this._resolved) {
      this._resolved = true;
      this.resolve(null);
    }
  }
}

// ------------------------------------------------------------------
//  OcclusionModal — drag-select rectangles over an image, commit
//  produces { rects: [{x,y,w,h}], mode: 'hide-one'|'show-one' } where
//  coords are fractions of the natural image dimensions (0..1).
//  Two commit buttons mirror SuperMemo: Hide-one / Show-one.
// ------------------------------------------------------------------
class OcclusionModal extends Modal {
  constructor(app, imageSrc, resolve) {
    super(app);
    this.imageSrc = imageSrc;
    this.resolve = resolve;
    this._resolved = false;
    this.rects = [];        // committed rects (in fractional 0..1 coords)
    this.dragStart = null;  // {x, y} in fractional coords, null if not dragging
    this.dragNow = null;
  }
  onOpen() {
    this.titleEl.setText('Occlusion: drag to draw rectangles');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ir-occ-modal');

    contentEl.createEl('p', {
      cls: 'ir-occ-help',
      text: 'Click-drag to add a rectangle. Right-click to remove. Shift+click a rect to set/clear its label. Choose mode at bottom to generate cards.'
    });

    const wrap = contentEl.createDiv({ cls: 'ir-occ-wrap' });

    const img = wrap.createEl('img', { cls: 'ir-occ-img' });
    img.src = this.imageSrc;
    img.draggable = false;

    const overlay = wrap.createDiv({ cls: 'ir-occ-overlay' });

    this.wrap = wrap;
    this.overlay = overlay;
    this.img = img;

    img.addEventListener('load', () => this._renderRects());

    const localFrac = (e) => {
      const r = overlay.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragStart = localFrac(e);
      this.dragNow = this.dragStart;
      this._renderRects();
    });
    window.addEventListener('mousemove', this._mouseMove = (e) => {
      if (!this.dragStart) return;
      this.dragNow = localFrac(e);
      this._renderRects();
    });
    window.addEventListener('mouseup', this._mouseUp = (e) => {
      if (!this.dragStart) return;
      const a = this.dragStart, b = this.dragNow || this.dragStart;
      const x = Math.max(0, Math.min(a.x, b.x));
      const y = Math.max(0, Math.min(a.y, b.y));
      const w = Math.min(1 - x, Math.abs(a.x - b.x));
      const h = Math.min(1 - y, Math.abs(a.y - b.y));
      this.dragStart = null; this.dragNow = null;
      // Reject tiny rects (treat as misclick)
      if (w > 0.005 && h > 0.005) this.rects.push({ x, y, w, h });
      this._renderRects();
    });

    const buttonRow = contentEl.createDiv({ cls: 'modal-button-container ir-occ-btnrow' });

    const hideOneBtn = buttonRow.createEl('button', { text: 'Generate: hide-one (N cards)', cls: 'mod-cta' });
    hideOneBtn.title = 'One card per rect; each card hides exactly that rect, reveals others.';
    hideOneBtn.addEventListener('click', () => this._commit('hide-one'));

    const showOneBtn = buttonRow.createEl('button', { text: 'Generate: show-one (N cards)' });
    showOneBtn.title = 'One card per rect; each card shows only that rect, hides others.';
    showOneBtn.addEventListener('click', () => this._commit('show-one'));

    const clearBtn = buttonRow.createEl('button', { text: 'Clear' });
    clearBtn.addEventListener('click', () => { this.rects = []; this._renderRects(); });

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this._cancel());

    this.statusEl = contentEl.createDiv({ cls: 'ir-occ-status' });
    this._updateStatus();
  }
  _updateStatus() {
    if (this.statusEl) this.statusEl.setText(`${this.rects.length} rectangle(s) drawn`);
  }
  _renderRects() {
    if (!this.overlay) return;
    this.overlay.empty();
    const drawCover = (r, color, idx) => {
      const div = this.overlay.createDiv({ cls: 'ir-occ-cover' });
      // Position is data-driven (fractional rect), so it stays inline via CSS vars.
      div.style.setProperty('--ir-x', (r.x * 100) + '%');
      div.style.setProperty('--ir-y', (r.y * 100) + '%');
      div.style.setProperty('--ir-w', (r.w * 100) + '%');
      div.style.setProperty('--ir-h', (r.h * 100) + '%');
      div.style.setProperty('--ir-cover-bg', color);
      if (idx != null) {
        const labelSuffix = r.label ? ` — "${r.label}"` : '';
        div.title = `Rect ${idx + 1}${labelSuffix} · shift+click=label · right-click=remove`;
        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.rects.splice(idx, 1);
          this._renderRects();
        });
        div.addEventListener('click', async (e) => {
          if (!e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          const cur = this.rects[idx]?.label || '';
          const next = await askText(this.app, `Label for rect ${idx + 1} (empty = clear)`, cur);
          if (next === null) return;
          if (next.trim() === '') delete this.rects[idx].label;
          else this.rects[idx].label = next.trim();
          this._renderRects();
        });
        if (r.label) {
          div.createDiv({ cls: 'ir-occ-label', text: r.label });
        }
      }
      return div;
    };
    this.rects.forEach((r, i) => drawCover(r, 'rgba(255, 215, 0, 0.55)', i));
    if (this.dragStart && this.dragNow) {
      const a = this.dragStart, b = this.dragNow;
      const r = {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
      };
      drawCover(r, 'rgba(255, 100, 100, 0.40)');
    }
    this._updateStatus();
  }
  _commit(mode) {
    if (this._resolved) return;
    if (this.rects.length === 0) { new Notice('Draw at least one rectangle first.'); return; }
    this._resolved = true;
    this.close();
    this.resolve({ rects: this.rects.slice(), mode });
  }
  _cancel() {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(null);
  }
  onClose() {
    if (this._mouseMove) window.removeEventListener('mousemove', this._mouseMove);
    if (this._mouseUp) window.removeEventListener('mouseup', this._mouseUp);
    this.contentEl.empty();
    if (!this._resolved) {
      this._resolved = true;
      this.resolve(null);
    }
  }
}

function askOcclusion(app, imageSrc) {
  return new Promise((res) => new OcclusionModal(app, imageSrc, res).open());
}

// ------------------------------------------------------------------
function askText(app, title, defaultValue = '') {
  return new Promise((res) => new TextPromptModal(app, title, defaultValue, res).open());
}

function pickFuzzy(app, items, displayFn, placeholder = '') {
  return new Promise((res) => new GenericSuggestModal(app, items, displayFn, res, placeholder).open());
}

function confirmDialog(app, title, message = '') {
  return new Promise((res) => new ConfirmModal(app, title, message, res).open());
}

function askLong(app, title, defaultValue = '') {
  return new Promise((res) => new LongTextModal(app, title, defaultValue, res).open());
}

async function pickFromList(app, displays, values, placeholder = '') {
  if (!values || values.length === 0) return null;
  const items = displays.map((d, i) => ({ d, v: values[i] }));
  const picked = await pickFuzzy(app, items, (i) => i.d, placeholder);
  return picked ? picked.v : null;
}

// ============================================================================
//  Vault helpers
// ============================================================================

function vaultAbsPath(app, relPath) {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;
  if (relPath) return adapter.getFullPath(normalizePath(relPath));
  const base = adapter.getBasePath();
  return base.endsWith('/') ? base : base + '/';
}

function getFm(app, file) {
  return file ? app.metadataCache.getFileCache(file)?.frontmatter : null;
}

function configuredPath(settings, key, fallback) {
  const value = String(settings?.paths?.[key] || fallback).trim();
  return normalizePath(value);
}

function getAllIRFiles(app, settings) {
  const folders = [
    configuredPath(settings, 'sources', SOURCES_FOLDER),
    configuredPath(settings, 'extracts', EXTRACTS_FOLDER),
    configuredPath(settings, 'cards', CARDS_FOLDER),
    CATEGORIES_FOLDER,
  ];
  const files = new Map();
  for (const folder of folders) {
    for (const file of filesInFolder(app, folder)) {
      if (file.extension === 'md') files.set(file.path, file);
    }
  }
  return Array.from(files.values());
}

function filesInFolder(app, folderPath) {
  const root = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!root) return [];
  const out = [];
  const visit = (node) => {
    if (node instanceof TFile) { out.push(node); return; }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

function getEditorForFile(app, file) {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    if (leaf.view?.file?.path === file.path) return leaf.view.editor;
  }
  return null;
}

function frontmatterEndOffset(content) {
  if (!content.startsWith('---\n')) return 0;
  const second = content.indexOf('\n---\n', 4);
  return second === -1 ? 0 : second + 5;
}

function markerLineNumber(content) {
  const match = String(content).match(/(?:📍\s*)?<!--ir-readpoint-->/);
  if (!match) return 0;
  return (content.slice(0, match.index).match(/\n/g) || []).length + 1;
}

// Sanitize basename → safe folder name (strip path-illegal chars, collapse ws).
function slugifyForFolder(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}

// SHA-1 → 12 hex chars. Stable, collision-safe enough for clipboard de-dupe.
async function shortHashOfBytes(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-1', arrayBuffer);
  return Array.from(new Uint8Array(digest)).slice(0, 6)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Read PNG from clipboard. Returns { bytes: ArrayBuffer, mime: 'image/png' } or null.
async function readImageFromClipboard() {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (!imgType) continue;
      const blob = await item.getType(imgType);
      const bytes = await blob.arrayBuffer();
      return { bytes, mime: imgType };
    }
  } catch (e) { /* permission or no image */ }
  return null;
}

// Ensure folder exists. Recursive (Obsidian's createFolder is shallow).
async function ensureFolder(app, path) {
  if (app.vault.getAbstractFileByPath(path)) return;
  const parts = path.split('/');
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); }
      catch (e) { if (!String(e?.message || '').includes('exists')) throw e; }
    }
  }
}

// Resolve source TFile + fm from active. Returns { tfile, fm } or null.
async function resolveSourceFromActive(app, settings) {
  const active = app.workspace.getActiveFile();
  if (!active) { new Notice('No active file.'); return null; }

  if (active.extension === 'md') {
    const fm = getFm(app, active);
    if (fm?.type === 'source') return { tfile: active, fm };
    new Notice('Active note is not an incremental reading source.');
    return null;
  }

  if (active.extension !== 'pdf') {
    new Notice('Active file must be a source note or PDF.');
    return null;
  }

  const absPath = vaultAbsPath(app, active.path);
  if (!absPath) { new Notice('Cannot resolve filesystem path.'); return null; }

  // Match by:
  //   1. exact filesystem path equality (Sioyek case — sioyek_path is absolute)
  //   2. suffix match for vault PDFs (PDF++ case — active.path is vault-relative,
  //      sioyek_path may store the same vault-absolute path or vault-relative)
  //   3. explicit pdf_vault_path field (preferred for PDF++-only sources)
  const vaultRel = active.path;
  const candidates = [];
  for (const f of filesInFolder(app, configuredPath(settings, 'sources', SOURCES_FOLDER))) {
    if (f.extension !== 'md') continue;
    const fm = getFm(app, f);
    if (fm?.type !== 'source') continue;
    const sioyek = fm.sioyek_path;
    const pdfVault = fm.pdf_vault_path;
    if (
      (sioyek && (sioyek === absPath || sioyek === vaultRel || (typeof sioyek === 'string' && sioyek.endsWith('/' + vaultRel)))) ||
      (pdfVault && pdfVault === vaultRel)
    ) {
      candidates.push({ tfile: f, fm });
    }
  }
  if (candidates.length === 0) {
    new Notice('No source note links to this PDF via sioyek_path.');
    return null;
  }
  if (candidates.length === 1) return candidates[0];

  let page = null;
  try {
    const eph = app.workspace.getMostRecentLeaf()?.getEphemeralState?.();
    const m = (eph?.subpath || '').match(/page=(\d+)/);
    if (m) page = parseInt(m[1], 10);
  } catch (e) { /* ignore */ }

  if (page != null) {
    const inRange = candidates.find(c => {
      const s = Number(c.fm.page_start) || null;
      const e = Number(c.fm.page_end) || null;
      return s && e && page >= s && page <= e;
    });
    if (inRange) return inRange;
  }

  return await pickFuzzy(
    app,
    candidates,
    c => `${c.tfile.basename}${(c.fm.page_start != null && c.fm.page_end != null) ? `  p.${c.fm.page_start}–${c.fm.page_end}` : ''}`,
    'Pick the source for this PDF',
  );
}

// Resolve a source/extract parent from active. If active is a card, follow
// its `source` frontmatter link up to the parent source/extract. Used by
// element-creation commands (extract / flashcard / image-extract) so they
// work when invoked from inside a card during review.
async function resolveSourceOrExtractFromActive(app, settings) {
  const active = app.workspace.getActiveFile();
  if (!active) { new Notice('No active file.'); return null; }

  if (active.extension === 'md') {
    const fm = getFm(app, active);
    if (fm?.type === 'source' || fm?.type === 'extract') {
      return { tfile: active, fm };
    }
    if (fm?.type === 'card') {
      const m = String(fm.source || '').match(/\[\[([^\]|#]+)/);
      if (!m) { new Notice('Card has no source link.'); return null; }
      const parentName = m[1].trim();
      const parentTf = app.metadataCache.getFirstLinkpathDest(parentName, active.path)
        || getAllIRFiles(app, settings).find(f => f.basename === parentName);
      if (!parentTf) { new Notice(`Parent not found: ${parentName}`); return null; }
      const parentFm = getFm(app, parentTf);
      if (!parentFm || (parentFm.type !== 'source' && parentFm.type !== 'extract')) {
        new Notice('Card parent is not a source/extract.'); return null;
      }
      return { tfile: parentTf, fm: parentFm };
    }
    new Notice('Active note is not an incremental reading source, extract, or card.');
    return null;
  }

  if (active.extension === 'pdf') return await resolveSourceFromActive(app, settings);
  new Notice('Active file must be an incremental reading element or PDF.');
  return null;
}

// Resolve any IR element from active (source / extract / card). Falls back
// to source-resolution when active is a PDF.
async function resolveIRFromActive(app, settings, { allowCard = true, allowPdfFallback = true } = {}) {
  const active = app.workspace.getActiveFile();
  if (!active) { new Notice('No active file.'); return null; }
  if (active.extension === 'md') {
    const fm = getFm(app, active);
    if (!fm) { new Notice('No frontmatter on active note.'); return null; }
    if (fm.type !== 'source' && fm.type !== 'extract' && (!allowCard || fm.type !== 'card')) {
      new Notice(`Active note is not an IR ${allowCard ? 'source/extract/card' : 'source/extract'}.`);
      return null;
    }
    return { tfile: active, fm };
  }
  if (active.extension === 'pdf' && allowPdfFallback) {
    return await resolveSourceFromActive(app, settings);
  }
  new Notice('Active file must be an incremental reading element or linked PDF.');
  return null;
}

// BFS subtree walk via parent + source links.
function walkSubtree(app, settings, rootBasename, rootPath, { includeCards = true } = {}) {
  const allPages = getAllIRFiles(app, settings)
    .map(f => ({ tfile: f, fm: getFm(app, f) }))
    .filter(p => p.fm && (p.fm.type === 'source' || p.fm.type === 'extract' || (includeCards && p.fm.type === 'card')));
  const paths = new Set([rootPath]);
  const frontier = [rootBasename];
  const basenameCounts = new Map();
  for (const page of allPages) {
    const key = page.tfile.basename.toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
  }
  while (frontier.length) {
    const next = [];
    for (const name of frontier) {
      if ((basenameCounts.get(name.toLowerCase()) || 0) > 1) continue;
      for (const p of allPages) {
        if (paths.has(p.tfile.path)) continue;
        if (linkPointsTo(p.fm.parent, name) || linkPointsTo(p.fm.source, name)) {
          paths.add(p.tfile.path);
          next.push(p.tfile.basename);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return Array.from(paths).map(path => {
    const tfile = app.vault.getAbstractFileByPath(path);
    return tfile ? { tfile, fm: getFm(app, tfile) } : null;
  }).filter(Boolean);
}

// ============================================================================
//  Visual learning — card generation policy
// ============================================================================
//
// Decides how many cards to spawn from a set of drawn rectangles, and
// which rect is the "question" for each. Two SuperMemo-canon modes:
//
//   hide-one : N cards. Each card hides ITS rect, reveals others.
//              Use for "what is this thing?" — anatomy labels, map regions,
//              labelled diagrams.
//
//   show-one : N cards. Each card shows ONLY its rect, hides others.
//              Use for "given this fragment alone, what surrounds it?" —
//              forces recall of context from a single landmark.
//
// Returns: Array<{ questionIndex: number }>. One element per generated card.
//
// LEARNING-MODE STUB — the default behavior generates one card per rect,
// each card pointing to its own rect as the question. Customise to:
//   - Skip generating cards for "label" rects (e.g. rects you only want as
//     visible context but never as questions). Filter before mapping.
//   - Collapse to ONE multi-blank card: return [{ questionIndex: -1 }] and
//     teach the renderer to treat -1 as "all rects are questions".
//   - Mix modes: pass a different `mode` for some rects (would also need
//     storage shape change so renderer knows).
function generateCardsFromRects(rects, mode) {
  // TODO(you): refine this policy. Default: 1 card per rect, in draw order.
  return rects.map((_r, i) => ({ questionIndex: i }));
}

// ============================================================================
//  Sidebar Queue View
// ============================================================================

const IR_QUEUE_VIEW_TYPE = 'ir-queue-view';

class IRQueueView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = plugin.settings.queue.default_tag_filter || '';
    this.refreshTimer = null;
    this.modifyTimer = null;
  }

  getViewType() { return IR_QUEUE_VIEW_TYPE; }
  getDisplayText() { return 'Reading queue'; }
  getIcon() { return 'list-checks'; }

  async onOpen() {
    this._render();
    this.registerEvent(this.plugin.app.vault.on('modify', () => {
      if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
      this.modifyTimer = window.setTimeout(() => this._render(), 250);
    }));
    this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => this._render()));
    this.refreshTimer = window.setInterval(() => this._render(), 30000);
  }

  async onClose() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
  }

  _render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('ir-queue-root');

    root.createDiv({ cls: 'ir-queue-header', text: 'Reading queue' });

    const filterInput = root.createEl('input', {
      cls: 'ir-queue-filter',
      type: 'text',
      placeholder: 'Filter by tag or title…',
    });
    filterInput.value = this.filter;
    filterInput.addEventListener('input', e => {
      this.filter = e.target.value;
      this._renderRows(root);
    });

    this._renderRows(root);
    this._renderTimeline(root);
  }

  _renderRows(root) {
    const filterInput = root.querySelector('.ir-queue-filter');
    while (filterInput && filterInput.nextSibling) filterInput.nextSibling.remove();

    const today = todayDate();

    // 1. Today's Session — snapshot order (matches dashboard).
    let session = this.plugin.readSessionSnapshot();
    if (!session) {
      // No fresh snapshot — derive but DO NOT persist.
      // Persisting would race with the dashboard's own snapshot logic.
      const pool = this.plugin.buildDuePool({ skipCurrent: false });
      session = this.plugin.buildInterleavedQueue(pool, today);
    }

    // 2. Build supplementary groups from a single full-file scan for items NOT in session.
    // Only exclude files that are themselves session entries (topics/file-cards) from
    // the supplementary groups — not parents merely hosting a session inline card.
    const sessionPaths = new Set(session.filter(s => !s.fm?.inline_parent).map(s => s.tfile.path));
    const groups = { overdue: [], newItems: [], active: [] };
    for (const file of getAllIRFiles(this.plugin.app, this.plugin.settings)) {
      if (sessionPaths.has(file.path)) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!isActiveIR(fm) || fm.type === 'card') continue;
      if (this._filterMiss(cache, file)) continue;
      const row = { tfile: file, file, fm };
      if (fm.status === 'pending' || fm.status === 'inbox') groups.newItems.push(row);
      else if (!fm.next_review) groups.active.push(row);
      else if (isPastDue(fm, today, this.plugin.settings)) groups.overdue.push(row);
    }

    // 3. Apply filter to session rows too; normalize so r.file is always populated.
    const sessionFiltered = session.filter(r => {
      const cache = this.plugin.app.metadataCache.getFileCache(r.tfile);
      return !this._filterMiss(cache, r.tfile);
    }).map(r => ({ ...r, file: r.tfile }));

    // 4. Sort overdue/active/new by sort_key (existing logic).
    const sortKey = this.plugin.settings.queue.sort_key;
    const sortFn = (a, b) => {
      if (sortKey === 'priority') return (a.fm.priority ?? 50) - (b.fm.priority ?? 50);
      if (sortKey === 'due_date') {
        const ad = parseDateValue(a.fm.next_review, this.plugin.settings);
        const bd = parseDateValue(b.fm.next_review, this.plugin.settings);
        return (ad?.getTime() ?? Infinity) - (bd?.getTime() ?? Infinity);
      }
      return urgency(b.fm, today, this.plugin.settings) - urgency(a.fm, today, this.plugin.settings);
    };
    groups.overdue.sort(sortFn);
    groups.newItems.sort(sortFn);
    groups.active.sort(sortFn);

    // 5. Render reading topics. Card queues belong to Spaced Repetition.
    this._renderSection(root, "Today's Session", sessionFiltered);
    this._renderSection(root, 'Overdue (not in session)', groups.overdue);
    this._renderSection(root, 'New', groups.newItems);
    this._renderSection(root, 'Active (no due)', groups.active);
  }

  _filterMiss(cache, file) {
    if (!this.filter) return false;
    const f = this.filter.toLowerCase();
    const tagHit = (cache?.tags || []).some(t => t.tag.toLowerCase().includes(f));
    const titleHit = file.basename.toLowerCase().includes(f);
    return !tagHit && !titleHit;
  }

  _renderSection(root, title, rows) {
    if (!rows.length) return;
    const sec = root.createDiv({ cls: 'ir-queue-section' });
    sec.createEl('div', { cls: 'ir-queue-section-title', text: `${title} (${rows.length})` });
    for (const r of rows) {
      const el = sec.createDiv({ cls: 'ir-queue-row' });
      el.createSpan({ text: ({ source: '📖', extract: '✂️', card: '🃏' })[r.fm.type] || '•' });
      el.createSpan({ cls: 'ir-queue-row-title', text: r.file.basename });
      el.createSpan({ cls: 'ir-queue-row-pri', text: `p${r.fm.priority ?? '?'}` });
      el.addEventListener('click', () => this._open(r));
    }
  }

  async _open(r) {
    if (r.fm.inline_parent) {
      await this.plugin._reviewInlineCard(r.fm.inline_parent, r.fm.id);
      this._render();
      return;
    }
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(r.file);
    this.plugin.app.commands.executeCommandById(`${this.plugin.manifest.id}:jump-to-read-point`);
  }

  _renderTimeline(root) {
    const active = this.plugin.app.workspace.getActiveFile();
    if (!active) return;
    const fm = this.plugin.app.metadataCache.getFileCache(active)?.frontmatter;
    if (!isActiveIR(fm)) return;

    const panel = root.createDiv({ cls: 'ir-timeline-panel' });
    panel.createEl('div', { cls: 'ir-queue-section-title', text: `Timeline: ${active.basename}` });

    for (const c of (fm.checkpoints || [])) {
      const row = panel.createDiv({ cls: 'ir-timeline-row' });
      row.setText(`${c.date} L${c.line} — ${c.note}`);
      row.addEventListener('click', async () => {
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(active);
        const ed = this.plugin.app.workspace.activeEditor?.editor;
        if (ed) ed.setCursor({ line: c.line, ch: 0 });
      });
    }

    const input = panel.createEl('input', { type: 'text', cls: 'ir-queue-filter', placeholder: 'New checkpoint (Nd:: optional)' });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        await this.plugin.addCheckpoint(input.value.trim());
        input.value = '';
        this._render();
      }
    });
  }
}

// ============================================================================
//  Settings Tab
// ============================================================================

class IncrementalReadingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this._scheduling(containerEl);
    this._queue(containerEl);
    this._inlineCards(containerEl);
    this._spacedRepetition(containerEl);
    this._paths(containerEl);
    this._misc(containerEl);
  }

  _scheduling(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    const s = this.plugin.settings.scheduling;
    const save = () => this.plugin.saveSettings();

    new Setting(sec)
      .setName('Progress-aware A-Factor')
      .setDesc('Recompute a_factor each rep from remaining pages/seconds.')
      .addToggle(t => t.setValue(s.progress_aware).onChange(v => { s.progress_aware = v; save(); }));

    new Setting(sec)
      .setName('Stall guard')
      .setDesc('Cap interval growth when read_point does not advance between reps.')
      .addToggle(t => t.setValue(s.stall_guard).onChange(v => { s.stall_guard = v; save(); }));

    new Setting(sec).setName('A-Factor min').addText(t =>
      t.setValue(String(s.a_factor_min)).onChange(v => { s.a_factor_min = Number(v) || 1.05; save(); }));
    new Setting(sec).setName('A-Factor max').addText(t =>
      t.setValue(String(s.a_factor_max)).onChange(v => { s.a_factor_max = Number(v) || 5.0; save(); }));

    new Setting(sec).setName('Quality factor — hold').addText(t =>
      t.setValue(String(s.quality_hold)).onChange(v => { s.quality_hold = Number(v) || 1.0; save(); }));
    new Setting(sec).setName('Quality factor — speed up').addText(t =>
      t.setValue(String(s.quality_speed_up)).onChange(v => { s.quality_speed_up = Number(v) || 0.95; save(); }));
    new Setting(sec).setName('Quality factor — slow down').addText(t =>
      t.setValue(String(s.quality_slow_down)).onChange(v => { s.quality_slow_down = Number(v) || 1.05; save(); }));

    new Setting(sec).setName('Initial A-Factor — base').addText(t =>
      t.setValue(String(s.initial_af_base)).onChange(v => { s.initial_af_base = Number(v) || 2.5; save(); }));
    new Setting(sec).setName('Initial A-Factor — slope').addText(t =>
      t.setValue(String(s.initial_af_slope)).onChange(v => { s.initial_af_slope = Number(v) || 0.25; save(); }));
    new Setting(sec).setName('Initial A-Factor — units divisor').addText(t =>
      t.setValue(String(s.initial_af_units_divisor)).onChange(v => { s.initial_af_units_divisor = Number(v) || 10; save(); }));

    new Setting(sec).setName('Extract bump').setDesc('Multiplier applied to parent a_factor when an extract is created.')
      .addText(t => t.setValue(String(s.extract_bump)).onChange(v => { s.extract_bump = Number(v) || 1.05; save(); }));
  }

  _queue(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Queue').setHeading();
    const s = this.plugin.settings.queue;
    const save = () => this.plugin.saveSettings();
    new Setting(sec).setName('Sidebar enabled')
      .addToggle(t => t.setValue(s.sidebar_enabled).onChange(v => { s.sidebar_enabled = v; save(); }));
    new Setting(sec).setName('Default tag filter')
      .addText(t => t.setValue(s.default_tag_filter).onChange(v => { s.default_tag_filter = v; save(); }));
    new Setting(sec).setName('Sort key').addDropdown(d => {
      d.addOption('urgency', 'Urgency').addOption('priority', 'Priority').addOption('due_date', 'Due date')
       .setValue(s.sort_key).onChange(v => { s.sort_key = v; save(); });
    });
  }

  _inlineCards(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Inline card export').setHeading();
    const s = this.plugin.settings.inline_cards;
    const save = () => this.plugin.saveSettings();
    new Setting(sec).setName('Enabled')
      .addToggle(t => t.setValue(s.enabled).onChange(v => { s.enabled = v; save(); }));
    new Setting(sec).setName('Q::A regex')
      .addText(t => t.setValue(s.qa_regex).onChange(v => { s.qa_regex = v; save(); }));
    new Setting(sec).setName('Cloze regex')
      .addText(t => t.setValue(s.cloze_regex).onChange(v => { s.cloze_regex = v; save(); }));
  }

  _spacedRepetition(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Spaced Repetition').setHeading();
    const s = this.plugin.settings.spaced_repetition;
    const save = () => this.plugin.saveSettings();
    new Setting(sec)
      .setName('Flashcard deck tag')
      .setDesc('Match a flashcard tag configured in Spaced Repetition. Do not include the leading #.')
      .addText(t => t.setValue(s.flashcardTag).onChange(v => {
        s.flashcardTag = v.replace(/^#/, '').trim() || 'flashcards/incremental-reading';
        save();
      }));
    new Setting(sec)
      .setName('Multiline card separator')
      .setDesc('Match the multiline separator configured in Spaced Repetition.')
      .addText(t => t.setValue(s.multilineCardSeparator).onChange(v => {
        s.multilineCardSeparator = v.trim() || '?';
        save();
      }));
    new Setting(sec)
      .setName('Bidirectional card separator')
      .setDesc('Match the multiline reversed separator configured in Spaced Repetition.')
      .addText(t => t.setValue(s.multilineReversedCardSeparator).onChange(v => {
        s.multilineReversedCardSeparator = v.trim() || '??';
        save();
      }));
  }

  _paths(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Paths').setHeading();
    const s = this.plugin.settings.paths;
    const save = () => this.plugin.saveSettings();
    const paths = [
      ['sources', 'Sources folder'],
      ['extracts', 'Extracts folder'],
      ['cards', 'Cards folder'],
      ['review_log', 'Review log file'],
      ['sioyek', 'Sioyek executable'],
    ];
    for (const [key, name] of paths) {
      new Setting(sec).setName(name)
        .addText(t => t.setValue(s[key]).onChange(v => { s[key] = v; save(); }));
    }
  }

  _misc(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Advanced').setHeading();
    const s = this.plugin.settings.misc;
    const save = () => this.plugin.saveSettings();
    new Setting(sec).setName('Date format')
      .setDesc('Used for scheduling fields, prompts, checkpoints, and the review log.')
      .addDropdown(d => {
        for (const format of dateCore.SUPPORTED_DATE_FORMATS) d.addOption(format, format);
        d.setValue(configuredDateFormat(this.plugin.settings)).onChange(async (value) => {
          const previous = configuredDateFormat(this.plugin.settings);
          if (previous === value) return;
          try {
            const changed = await this.plugin.migrateDateFormat(previous, value);
            s.date_format = value;
            await save();
            new Notice(`Date format changed to ${value}; migrated ${changed} stored date${changed === 1 ? '' : 's'}.`);
          } catch (error) {
            new Notice(`Date migration failed: ${error.message}`);
          }
        });
      });
    new Setting(sec).setName('Debug logging')
      .addToggle(t => t.setValue(s.debug).onChange(v => { s.debug = v; save(); }));
  }
}

// ============================================================================
//  Plugin
// ============================================================================

const TREE_ICONS = { category: '📁', source: '📖', extract: '✂️', card: '🃏' };

class KnowledgeTreeView extends ItemView {
  constructor(leaf, plugin, mode) {
    super(leaf);
    this.plugin = plugin;
    this.mode = mode || 'main';
    this.filter = '';
    this._match = null;
    this.index = null;
    this.refreshTimer = null;
  }

  getViewType() { return this.mode === 'sidebar' ? KNOWLEDGE_TREE_SIDEBAR_TYPE : KNOWLEDGE_TREE_VIEW_TYPE; }
  getDisplayText() { return 'Knowledge tree'; }
  getIcon() { return 'folder-tree'; }

  async onOpen() {
    this._render();
    this.registerEvent(this.plugin.app.metadataCache.on('changed', () => {
      if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this._renderBody(), 300);
    }));
  }
  async onClose() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  // Full render: rebuilds toolbar + body. Used on open and cross-view refresh.
  // Internal updates (filter typing, expand, drag, edits) call _renderBody only, so
  // the filter <input> is not recreated mid-typing (which would drop focus).
  _render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('ir-tree-root');
    root.toggleClass('ir-tree-main', this.mode === 'main');
    root.toggleClass('ir-tree-compact', this.mode === 'sidebar');

    const bar = root.createDiv({ cls: 'ir-tree-toolbar' });
    if (this.mode === 'main') {
      const b1 = bar.createEl('button', { text: '+ Category' });
      b1.onclick = async () => { await this.plugin.createCategory(); this._renderBody(); };
      const b2 = bar.createEl('button', { text: 'Expand all' });
      b2.onclick = () => { this._setExpandAll(true); this._renderBody(); };
      const b3 = bar.createEl('button', { text: 'Collapse all' });
      b3.onclick = () => { this._setExpandAll(false); this._renderBody(); };
    }
    const fi = bar.createEl('input', { cls: 'ir-tree-filter', type: 'text', placeholder: 'Filter by title or tag…' });
    fi.value = this.filter;
    fi.oninput = (e) => { this.filter = e.target.value; this._renderBody(); };

    this._bodyEl = root.createDiv({ cls: 'ir-tree-body' });
    if (this.mode === 'main') {
      this._bodyEl.addEventListener('dragover', (e) => { e.preventDefault(); });
      this._bodyEl.addEventListener('drop', async (e) => {
        const src = e.dataTransfer.getData('text/ir-path');
        if (src) { await this.plugin.reparent(src, null); this._renderBody(); }
      });
    }
    this._renderBody();
  }

  _renderBody() {
    if (!this._bodyEl) { this._render(); return; }
    this._bodyEl.empty();
    this.index = this.plugin.buildTreeIndex();
    this._computeFilter();
    const catRoots = this.index.roots.filter(p => p.fm.type === 'category' && !treeCore.effectiveParent(p.fm));
    const loose = this.index.roots.filter(p => !(p.fm.type === 'category' && !treeCore.effectiveParent(p.fm)));
    for (const p of catRoots) this._renderNode(this._bodyEl, p, 0);
    this._renderUnfiled(this._bodyEl, loose);
  }

  _computeFilter() {
    const f = this.filter.trim().toLowerCase();
    if (!f) { this._match = null; return; }
    const matches = (p) => {
      if (p.basename.toLowerCase().includes(f)) return true;
      const tags = p.fm && p.fm.tags;
      const tagStr = Array.isArray(tags) ? tags.join(' ') : String(tags || '');
      return tagStr.toLowerCase().includes(f);
    };
    const keep = new Set();
    for (const p of this.index.pages) {
      if (!matches(p)) continue;
      let cur = p;
      const guard = new Set();
      while (cur) {
        keep.add(cur.path);
        const up = treeCore.effectiveParent(cur.fm);
        if (!up) break;
        const next = this.index.byName.get(up.toLowerCase());
        if (!next || guard.has(next.path)) break;
        guard.add(next.path);
        cur = next;
      }
    }
    this._match = { keep };
  }

  _renderNode(parentEl, page, depth) {
    if (depth > 50) return;
    if (this._match && !this._match.keep.has(page.path)) return;

    const key = page.path;
    const children = this.index.childrenOf.get(page.basename.toLowerCase()) || [];
    const hasChildren = children.length > 0;
    const expanded = !!this._match || this.plugin.isExpanded(key);

    const row = parentEl.createDiv({ cls: 'ir-tree-row' });
    // Indent scales with tree depth, so it stays inline via a CSS var.
    row.style.setProperty('--ir-tree-depth', String(depth));

    const tw = row.createSpan({ cls: 'ir-tree-twisty', text: hasChildren ? (expanded ? '▼' : '▶') : '' });
    if (hasChildren) tw.onclick = (e) => { e.stopPropagation(); this.plugin.toggleExpanded(key); this._renderBody(); };

    row.createSpan({ cls: 'ir-tree-icon', text: TREE_ICONS[page.fm.type] || '•' });
    row.createSpan({ cls: 'ir-tree-title', text: page.basename });

    const parentName = treeCore.effectiveParent(page.fm);
    if (parentName && !this.index.byName.has(parentName.toLowerCase())) {
      const w = row.createSpan({ cls: 'ir-tree-warn', text: '⚠' });
      w.title = `Parent not found: ${parentName}`;
    }

    if (this.mode === 'main') {
      if (page.fm.type !== 'category') {
        row.createSpan({ cls: 'ir-tree-pri', text: `p${page.fm.priority ?? '?'}` });
      }
      if (hasChildren) {
        const cc = row.createSpan({ cls: 'ir-tree-count', text: String(children.length) });
        if (children.length > this.plugin.settings.tree.child_warn_threshold) cc.addClass('ir-tree-count-warn');
      }
      this._attachDrag(row, page);
      this._attachActions(row, page);
    }

    row.onclick = () => this._openPage(page);

    if (expanded && hasChildren) {
      for (const c of children) this._renderNode(parentEl, c, depth + 1);
    }
  }

  _renderUnfiled(body, loose) {
    const visible = this._match ? loose.filter(p => this._match.keep.has(p.path)) : loose;
    if (!visible.length) return;
    const key = '::unfiled::';
    const expanded = !!this._match || this.plugin.isExpanded(key);
    const row = body.createDiv({ cls: 'ir-tree-row ir-tree-unfiled' });
    const tw = row.createSpan({ cls: 'ir-tree-twisty', text: expanded ? '▼' : '▶' });
    tw.onclick = (e) => { e.stopPropagation(); this.plugin.toggleExpanded(key); this._renderBody(); };
    row.createSpan({ cls: 'ir-tree-icon', text: '📥' });
    row.createSpan({ cls: 'ir-tree-title', text: `Unfiled (${visible.length})` });
    if (expanded) for (const p of visible) this._renderNode(body, p, 1);
  }

  _setExpandAll(on) {
    if (!on) { this.plugin.settings.tree.expanded = []; this.plugin.saveSettings(); return; }
    const keys = ['::unfiled::'];
    for (const p of this.index.pages) {
      if ((this.index.childrenOf.get(p.basename.toLowerCase()) || []).length) keys.push(p.path);
    }
    this.plugin.settings.tree.expanded = keys;
    this.plugin.saveSettings();
  }

  async _openPage(page) {
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(page.tfile);
    if (page.fm.type === 'source' || page.fm.type === 'extract') {
      this.plugin.app.commands.executeCommandById(`${this.plugin.manifest.id}:jump-to-read-point`);
    }
  }

  _attachDrag(row, page) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/ir-path', page.path);
      e.dataTransfer.effectAllowed = 'move';
    });
    if (page.fm.type === 'card') return;   // cards are leaves, never drop targets
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.addClass('ir-tree-drop'); });
    row.addEventListener('dragleave', () => row.removeClass('ir-tree-drop'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      row.removeClass('ir-tree-drop');
      const src = e.dataTransfer.getData('text/ir-path');
      if (!src || src === page.path) return;
      await this.plugin.reparent(src, page.basename);
      this._renderBody();
    });
  }

  _attachActions(row, page) {
    const actions = row.createDiv({ cls: 'ir-tree-actions' });
    const up = actions.createEl('button', { text: '↑' });
    up.title = 'Move up';
    up.onclick = async (e) => { e.stopPropagation(); await this.plugin.reorderSibling(page.path, -1); this._renderBody(); };
    const down = actions.createEl('button', { text: '↓' });
    down.title = 'Move down';
    down.onclick = async (e) => { e.stopPropagation(); await this.plugin.reorderSibling(page.path, +1); this._renderBody(); };
    const ren = actions.createEl('button', { text: '✎' });
    ren.title = 'Rename';
    ren.onclick = async (e) => { e.stopPropagation(); await this.plugin.renameTreeNode(page.path); this._renderBody(); };
    const dis = actions.createEl('button', { text: '✕' });
    dis.title = 'Dismiss';
    dis.onclick = async (e) => { e.stopPropagation(); await this.plugin.dismissTreeNode(page.path); this._renderBody(); };
  }
}

class IncrementalReadingPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      this.settings[key] = Object.assign({}, DEFAULT_SETTINGS[key], this.settings[key] || {});
    }
    await this.saveData(this.settings);
    this.addSettingTab(new IncrementalReadingSettingTab(this.app, this));
    this.registerView(IR_QUEUE_VIEW_TYPE, leaf => new IRQueueView(leaf, this));
    this.registerView(KNOWLEDGE_TREE_VIEW_TYPE, leaf => new KnowledgeTreeView(leaf, this, 'main'));
    this.registerView(KNOWLEDGE_TREE_SIDEBAR_TYPE, leaf => new KnowledgeTreeView(leaf, this, 'sidebar'));
    const cmd = (id, name, callback) => this.addCommand({ id, name, callback });

    // ---- Visual learning code-block renderer ----
    this.registerMarkdownCodeBlockProcessor('ir-occlusion', (source, el, ctx) => {
      let data;
      try { data = parseYaml(source) || {}; }
      catch (e) {
        el.createEl('div', { text: `[ir-occlusion] yaml parse error: ${e.message}` });
        return;
      }
      if (!data.image || !Array.isArray(data.rects) || data.rects.length === 0) {
        el.createEl('div', { text: '[ir-occlusion] missing image or rects' });
        return;
      }
      const mode = data.mode || 'hide-one';
      const qIdx = Number.isFinite(data.question_index) ? data.question_index : 0;

      const tf = this.app.vault.getAbstractFileByPath(data.image)
        || this.app.metadataCache.getFirstLinkpathDest(data.image, ctx.sourcePath);
      if (!tf) {
        el.createEl('div', { text: `[ir-occlusion] image not found: ${data.image}` });
        return;
      }
      const src = this.app.vault.adapter.getResourcePath(tf.path);

      const wrap = el.createDiv({ cls: 'ir-occ-wrap' });

      const img = wrap.createEl('img', { cls: 'ir-occ-img-fluid' });
      img.src = src;
      img.draggable = false;

      const overlay = wrap.createDiv({ cls: 'ir-occ-overlay ir-occ-overlay-static' });

      const isHidden = (i) => qIdx === -1
        ? true
        : (mode === 'hide-one' ? i === qIdx : i !== qIdx);

      const covers = data.rects.map((r, i) => {
        const d = overlay.createDiv({ cls: 'ir-occ-cover ir-occ-cover-plain' });
        d.style.setProperty('--ir-x', (r.x * 100) + '%');
        d.style.setProperty('--ir-y', (r.y * 100) + '%');
        d.style.setProperty('--ir-w', (r.w * 100) + '%');
        d.style.setProperty('--ir-h', (r.h * 100) + '%');
        const hidden = isHidden(i);
        if (hidden) d.addClass('ir-occ-cover-hidden');
        if (i === qIdx) d.addClass('ir-occ-cover-current');
        if (r.label) d.title = r.label;
        return { div: d, hidden };
      });

      const btnRow = el.createDiv({ cls: 'ir-occ-btn-row' });
      const btn = btnRow.createEl('button', { text: 'Show answer' });
      let revealed = false;
      btn.addEventListener('click', () => {
        revealed = !revealed;
        overlay.toggleClass('ir-occ-revealed', revealed);
        btn.setText(revealed ? 'Hide Answer' : 'Show Answer');
      });
    });

    // Core review loop
    cmd('next-element',       'Next element',                    () => this.nextElement());
    cmd('random-due',         'Random due element',              () => this.randomDue());
    cmd('grade-and-advance',  'Grade and advance',               () => this.gradeAndAdvance());
    cmd('end-session',        'End session (grade current)',     () => this.endSession());
    cmd('done',               'Done',                            () => this.markDone());
    cmd('dismiss',            'Dismiss',                         () => this.dismiss());
    cmd('postpone',           'Postpone',                        () => this.postpone());
    cmd('schedule',           'Schedule (manual date)',          () => this.schedule());
    cmd('review-cards',       'Review cards (Spaced Repetition)', () => this.reviewCards());
    cmd('review-cards-in-note','Review cards in current note (Spaced Repetition)', () => this.reviewCardsInNote());
    cmd('migrate-cards-to-spaced-repetition', 'Migrate legacy cards to Spaced Repetition', () => this.migrateLegacyCards());

    // Element creation
    cmd('extract-selection',  'Extract selection',               () => this.extractSelection());
    cmd('extract-clipboard',  'Extract from clipboard (PDF-aware)', () => this.extractClipboard());
    cmd('flashcard-clipboard','Flashcard from clipboard',        () => this.flashcardClipboard());
    cmd('flashcard-image-name','Flashcard: name this image',     () => this.flashcardImageName());
    cmd('image-extract-clipboard', 'Image extract from clipboard', () => this.imageExtractClipboard());
    cmd('occlusion-create',   'Occlusion: create cards from image', () => this.occlusionCreate());
    cmd('source-new',         'New source',                      () => this.newSource());
    cmd('import-clipping',    'Import clipping (active note)',   () => this.importClipping());

    // Priority / scheduling
    cmd('set-priority',       'Set priority',                    () => this.setPriority());
    cmd('boost',              'Boost priority',                  () => this.boost());

    // Subset / overload
    cmd('subset-review',      'Subset review',                   () => this.subsetReview());
    cmd('mercy',              'Mercy (spread overdue)',          () => this.mercy());
    cmd('postpone-subtree',   'Postpone subtree',                () => this.postponeSubtree());

    // Navigation / reading
    cmd('open-dashboard',     'Open dashboard',                  () => this.openDashboard());
    cmd('open-parent',        'Open parent',                     () => this.openParent());
    cmd('open-pdf',           'Open PDF (Obsidian viewer)',      () => this.openPdf());
    cmd('open-sioyek',        'Open in Sioyek',                  () => this.openSioyek());
    cmd('toggle-read-point',  'Toggle read-point',               () => this.toggleReadPoint());
    cmd('jump-to-read-point', 'Jump to read-point',              () => this.jumpToReadPoint());
    cmd('stats',              'Stats',                           () => this.stats());

    // Splits
    cmd('split-article',      'Split article on H2 headings',    () => this.splitArticle());
    cmd('split-book',         'Split book into chapters',        () => this.splitBook());

    // Sidebar + checkpoints
    cmd('open-reading-queue',  'Open reading queue sidebar',  () => this._activateQueueView());
    cmd('open-knowledge-tree',         'Open knowledge tree',           () => this._activateKnowledgeTree());
    cmd('open-knowledge-tree-sidebar', 'Open knowledge tree (sidebar)', () => this._activateKnowledgeTreeSidebar());
    cmd('new-category',                'New category',                  async () => { await this.createCategory(); this._refreshTreeViews(); });
    cmd('tree-reparent-active',        'Move active element under…',    async () => { await this.reparentActive(); this._refreshTreeViews(); });
    cmd('checkpoint',     'Add timeline checkpoint', () => this.addCheckpoint());
    cmd('seed-inline-cards', 'Export inline cards to Spaced Repetition', () => this.seedInlineCards());
    this.app.workspace.onLayoutReady(() => {
      const count = this._legacyCardFiles().length;
      if (count) new Notice(`Incremental Reading Toolkit: ${count} legacy card${count === 1 ? '' : 's'} found. Run "Migrate legacy cards to Spaced Repetition".`, 10000);
    });
  }

  sourcesFolder() { return configuredPath(this.settings, 'sources', SOURCES_FOLDER); }
  extractsFolder() { return configuredPath(this.settings, 'extracts', EXTRACTS_FOLDER); }
  cardsFolder() { return configuredPath(this.settings, 'cards', CARDS_FOLDER); }
  reviewLogPath() { return configuredPath(this.settings, 'review_log', REVIEW_LOG_PATH); }

  _nativeCardText(value) {
    return spacedRepetitionCore.nativeCardText(value);
  }

  _spacedRepetitionSettings() {
    return this.settings.spaced_repetition || DEFAULT_SETTINGS.spaced_repetition;
  }

  _spacedRepetitionDeckTag() {
    const configured = this._spacedRepetitionSettings().flashcardTag;
    return String(configured || 'flashcards/incremental-reading').replace(/^#/, '').replace(/\/+$/, '');
  }

  _spacedRepetitionBody(format, question, answer) {
    return spacedRepetitionCore.spacedRepetitionBody(
      format,
      question,
      answer,
      this._spacedRepetitionSettings()
    );
  }

  async _createSpacedRepetitionCard(parentFile, { format, question, answer = '', extraFrontmatter = [] }) {
    const folder = this.cardsFolder();
    await ensureFolder(this.app, folder);
    const parentTitle = parentFile.basename;
    const safeParent = slugifyForFolder(parentTitle) || 'Untitled';
    const existing = filesInFolder(this.app, folder).filter(f =>
      f.extension === 'md' && f.basename.startsWith(safeParent + ' - Card'));
    let cardNum = existing.length + 1;
    let name = `${safeParent} - Card ${cardNum}`;
    while (this.app.vault.getAbstractFileByPath(`${folder}/${name}.md`)) {
      name = `${safeParent} - Card ${++cardNum}`;
    }
    const fm = [
      '---',
      'type: card',
      `source: ${JSON.stringify(`[[${parentTitle}]]`)}`,
      `date_added: ${todayDateString(this.settings)}`,
      `card_format: ${format}`,
      'ir_spaced_repetition: true',
      ...extraFrontmatter,
      'tags:',
      '  - incremental-reading',
      '  - ir/card',
      `  - ${this._spacedRepetitionDeckTag()}`,
      '---',
      '',
    ];
    const file = await this.app.vault.create(
      `${folder}/${name}.md`,
      fm.join('\n') + this._spacedRepetitionBody(format, question, answer)
    );
    return { file, name };
  }

  _legacyCardFiles() {
    return filesInFolder(this.app, this.cardsFolder()).filter(file => {
      if (file.extension !== 'md') return false;
      const fm = getFm(this.app, file);
      const tags = Array.isArray(fm?.tags)
        ? fm.tags.map(String)
        : (typeof fm?.tags === 'string' ? fm.tags.split(/[\s,]+/).filter(Boolean) : []);
      const deckTag = this._spacedRepetitionDeckTag();
      return fm?.type === 'card' && fm.ir_spaced_repetition !== true
        && !tags.some(tag => tag.replace(/^#/, '') === deckTag);
    });
  }

  async migrateLegacyCards() {
    const files = this._legacyCardFiles();
    if (!files.length) { new Notice('No legacy IR cards to migrate.'); return; }
    const ok = await confirmDialog(
      this.app,
      `Migrate ${files.length} legacy card${files.length === 1 ? '' : 's'}?`,
      'Card content will be converted to Spaced Repetition syntax. IR scheduling fields will be removed.'
    );
    if (!ok) return;

    let migrated = 0, skipped = 0;
    for (const file of files) {
      const fm = getFm(this.app, file) || {};
      const content = await this.app.vault.read(file);
      const body = content.slice(frontmatterEndOffset(content))
        .replace(/^\s*<div style="height: 90vh;"><\/div>\s*/, '')
        .replace(BODY_MARKER, '')
        .trim();
      let format = fm.card_format || 'basic';
      let question = body, answer = '';

      if (format === 'occlusion') {
        answer = fm.occlusion_image ? `![[${fm.occlusion_image}]]` : '';
      } else if (format === 'cloze') {
        const selected = Math.max(1, Number(fm.cloze_index) || 1);
        let index = 0;
        question = body.replace(new RegExp(HL_CLOZE_SRC, 'g'), (match, text) => {
          index++;
          return index === selected ? match : text;
        });
      } else {
        const marker = /\n> \[!answer\]- Answer\s*\n/;
        const parts = body.split(marker);
        if (parts.length < 2) { skipped++; continue; }
        question = parts.shift().trim();
        answer = parts.join('\n').split('\n').map(line => line.replace(/^> ?/, '')).join('\n').trim();
        format = 'basic';
      }

      await this.app.fileManager.processFrontMatter(file, (next) => {
        if (typeof next.tags === 'string') next.tags = next.tags.split(/[\s,]+/).filter(Boolean);
        if (!Array.isArray(next.tags)) next.tags = [];
        for (const tag of ['incremental-reading', 'ir/card', this._spacedRepetitionDeckTag()]) {
          if (!next.tags.includes(tag)) next.tags.push(tag);
        }
        next.ir_spaced_repetition = true;
        next.card_format = format;
        for (const key of [
          'status', 'priority', 'next_review', 'interval', 'review_count', 'last_reviewed',
          'last_grade', 'last_retrievability', 'stability', 'difficulty', 'cssclasses',
        ]) delete next[key];
      });
      await this.app.vault.process(file, (current) =>
        current.slice(0, frontmatterEndOffset(current)) + this._spacedRepetitionBody(format, question, answer)
      );
      migrated++;
    }
    new Notice(`Migrated ${migrated} card${migrated === 1 ? '' : 's'} to Spaced Repetition${skipped ? `; skipped ${skipped}` : ''}.`);
  }

  reviewCards() {
    if (!this.app.commands.executeCommandById(SPACED_REPETITION_REVIEW_COMMAND)) {
      new Notice('Spaced Repetition is still starting. Reload Obsidian and try again.');
    }
  }

  reviewCardsInNote() {
    if (!this.app.commands.executeCommandById(SPACED_REPETITION_NOTE_COMMAND)) {
      new Notice('Open a card note, then try again after Spaced Repetition has initialized.');
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async migrateDateFormat(fromFormat, toFormat) {
    const keys = ['next_review', 'last_reviewed', 'date_added', 'date_dismissed', 'today_session_date'];
    const files = new Map(getAllIRFiles(this.app, this.settings).map(file => [file.path, file]));
    const dashboard = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (dashboard instanceof TFile) files.set(dashboard.path, dashboard);
    let changed = 0;
    for (const file of files.values()) {
      if (!getFm(this.app, file)) continue;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const key of keys) {
          if (!fm[key]) continue;
          const next = dateCore.reformatDate(fm[key], fromFormat, toFormat);
          if (next !== fm[key]) { fm[key] = next; changed++; }
        }
        if (Array.isArray(fm.checkpoints)) {
          for (const checkpoint of fm.checkpoints) {
            if (!checkpoint?.date) continue;
            const next = dateCore.reformatDate(checkpoint.date, fromFormat, toFormat);
            if (next !== checkpoint.date) { checkpoint.date = next; changed++; }
          }
        }
      });
    }
    const logFile = this.app.vault.getAbstractFileByPath(this.reviewLogPath());
    if (logFile instanceof TFile) {
      await this.app.vault.process(logFile, (content) => content.split('\n').map(line => {
        const match = line.match(/^(\|\s*)([^|]+?)(\s*\|)/);
        if (!match) return line;
        const value = match[2].trim();
        const next = dateCore.reformatDate(value, fromFormat, toFormat);
        if (next === value) return line;
        changed++;
        return match[1] + next + match[3] + line.slice(match[0].length);
      }).join('\n'));
    }
    return changed;
  }

  // Debug logging — silent unless the user enables it in settings. Keeps the
  // default console clean (Obsidian guideline: only errors by default).
  _dbg(...args) {
    if (this.settings?.misc?.debug) console.log('[Incremental Reading Toolkit]', ...args);
  }

  // ---- Next / Random -----------------------------------------------------

  buildDuePool({ skipCurrent = true } = {}) {
    const today = todayDate();
    const active = this.app.workspace.getActiveFile();
    const out = [];
    for (const f of getAllIRFiles(this.app, this.settings)) {
      if (skipCurrent && active && f.path === active.path) continue;
      const fm = getFm(this.app, f);
      if (!isActiveIR(fm) || fm.type === 'card') continue;
      if (!isDue(fm, today, this.settings)) continue;
      out.push({ tfile: f, fm });
    }
    return out;
  }

  // Read the dashboard's session snapshot (path list persisted as
  // `today_session_paths`). Returns active, not-reviewed-today items in
  // snapshot order. Null if no fresh snapshot exists.
  readSessionSnapshot() {
    const dash = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!dash) return null;
    const fm = getFm(this.app, dash);
    const todayStr = todayDateString(this.settings);
    if (!fm || fm.today_session_date !== todayStr) return null;
    const paths = fm.today_session_paths;
    if (!Array.isArray(paths) || paths.length === 0) return null;
    const today = todayDate();
    const out = [];
    const seen = new Set();
    for (const p of paths) {
      if (seen.has(p)) continue;   // drop duplicate snapshot keys
      seen.add(p);
      if (typeof p === 'string' && p.includes('::card::')) continue;
      const tf = this.app.vault.getAbstractFileByPath(p);
      if (!tf) continue;
      const f = getFm(this.app, tf);
      if (!isActiveIR(f)) continue;
      if (f.last_reviewed === todayStr) continue;
      if (!isDue(f, today, this.settings)) continue;
      out.push({ tfile: tf, fm: f });
    }
    return out;
  }

  async persistSessionSnapshot(queue) {
    const dash = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!dash) return;
    const paths = queue.map(q => q.tfile?.path).filter(Boolean);
    if (!paths.length) return;
    try {
      await this.app.fileManager.processFrontMatter(dash, (fm) => {
        fm.today_session_paths = paths;
        fm.today_session_date = todayDateString(this.settings);
      });
    } catch (e) {
      console.error('[IR] persistSessionSnapshot failed', e);
    }
  }

  buildInterleavedQueue(pool, today) {
    return pool.slice().sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
  }

  async nextElement() {
    const active = this.app.workspace.getActiveFile();
    let queue = this.readSessionSnapshot();
    if (queue && queue.length) {
      queue = queue.filter(p => !active || p.tfile.path !== active.path);
    } else {
      const pool = this.buildDuePool();
      if (pool.length === 0) { new Notice('✨ Nothing due. Caught up.'); return; }
      queue = this.buildInterleavedQueue(pool, todayDate());
      // Persist so dashboard renders the same order on next open.
      await this.persistSessionSnapshot(queue);
    }
    if (!queue || queue.length === 0) { new Notice('✨ Caught up.'); return; }

    const next = queue[0];
    await this.app.workspace.getLeaf(false).openFile(next.tfile);
    const action = next.fm.type === 'source' ? '📖 Read' : '📝 Process';
    new Notice(`${action}: ${next.tfile.basename} · p${next.fm.priority ?? '—'} · ${queue.length - 1} more in queue`);
  }

  async randomDue() {
    const pool = this.buildDuePool();
    if (pool.length === 0) { new Notice('✨ Nothing due. Caught up.'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    await this.app.workspace.getLeaf(false).openFile(pick.tfile);
    const action = pick.fm.type === 'source' ? '📖 Read' : '📝 Process';
    new Notice(`🎲 ${action}: ${pick.tfile.basename} · p${pick.fm.priority ?? '—'} (1 of ${pool.length} due)`);
  }

  async gradeAndAdvance() {
    if (getFm(this.app, this.app.workspace.getActiveFile())?.type === 'card') {
      this.reviewCardsInNote();
      return;
    }
    await this.endSession();
    await this.nextElement();
  }

  // ---- End Session (A-Factor topics; cards delegate to Spaced Repetition) -

  async endSession() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') {
      new Notice('Open an incremental reading source, extract, or card first.');
      return;
    }
    const fm = getFm(this.app, active);
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card')) {
      new Notice('Active note is not an incremental reading element.');
      return;
    }
    const today = todayDateString(this.settings);

    if (fm.type === 'card') {
      this.reviewCardsInNote();
      return;
    }
    await this._gradeTopic(active, fm, today);
  }

  async _gradeTopic(file, fm, today) {
    let newReadPoint = fm.read_point;
    let newReadPointSeconds = fm.read_point_seconds;
    let previousReadPointLine = Number(fm.read_point_line) || 0;
    let newReadPointLine = previousReadPointLine;
    const isVideo = fm.type === 'source'
      && (fm.source_type === 'youtube' || fm.source_type === 'video' || fm.read_point_seconds != null);
    if (fm.type === 'source' && fm.read_point != null && !isVideo) {
      const rp = await askText(this.app, 'Page you stopped at', String(fm.read_point));
      if (rp === null) return;
      const parsed = parseInt(rp, 10);
      if (Number.isFinite(parsed)) newReadPoint = parsed;
    } else if (isVideo) {
      const cur = formatSeconds(Number(fm.read_point_seconds) || 0);
      const raw = await askText(this.app, 'Timestamp you stopped at (mm:ss or hh:mm:ss)', cur);
      if (raw === null) return;
      const parsed = parseTimeInput(raw);
      if (parsed != null) newReadPointSeconds = parsed;
    }

    const isMarkdownSource = fm.type === 'source' && !fm.total_pages && !fm.sioyek_path;
    if (isMarkdownSource) {
      const currentContent = await this.app.vault.cachedRead(file);
      if (!previousReadPointLine) previousReadPointLine = markerLineNumber(currentContent);
      if (!newReadPointLine) newReadPointLine = previousReadPointLine;
      const editor = getEditorForFile(this.app, file);
      const cursor = editor?.getCursor?.();
      if (editor && cursor) {
        const updateMarker = await confirmDialog(this.app, `Update 📍 to line ${cursor.line + 1}?`);
        if (updateMarker) {
          newReadPointLine = cursor.line + 1;
          await this.app.vault.process(file, (content) => {
            const fmEnd = frontmatterEndOffset(content);
            const lines = content.split('\n');
            let insertAt = 0;
            for (let i = 0; i < cursor.line; i++) insertAt += lines[i].length + 1;
            if (insertAt < fmEnd) insertAt = fmEnd;
            let stripped = content;
            const existing = [...content.matchAll(READ_POINT_RE)];
            if (existing.length) {
              for (const m of existing.reverse()) {
                stripped = stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length);
                if (m.index < insertAt) insertAt -= m[0].length;
              }
            }
            return stripped.slice(0, insertAt) + READ_POINT_MARKER + stripped.slice(insertAt);
          });
          new Notice(`📍 moved to line ${cursor.line + 1}`);
        }
      }
    }

    const priority = fm.priority ?? 50;
    const s = this.settings.scheduling;

    // Capture pre-rep read position to drive stall guard.
    const prevReadPoint = Number(fm.read_point) || 0;
    const prevReadSeconds = Number(fm.read_point_seconds) || 0;

    const priorAFactor = readAFactor(this.settings, fm);
    const progressAF = s.progress_aware ? topicCore.progressAwareAFactor(fm, this.settings, {
      readPoint: newReadPoint,
      readPointSeconds: newReadPointSeconds,
    }) : null;
    const baseAF = progressAF != null ? progressAF : priorAFactor;

    const qualityFactor = await pickFromList(
      this.app,
      ['Hold (no change)',
       `Speed up (×${s.quality_speed_up} — see sooner)`,
       `Slow down (×${s.quality_slow_down} — push out)`],
      [s.quality_hold, s.quality_speed_up, s.quality_slow_down],
      'Topic quality?'
    );
    if (qualityFactor == null) return;
    const aFactor = clampAFactor(this.settings, baseAF * qualityFactor);

    const priorReps = fm.review_count ?? 0;
    const reviewCount = priorReps + 1;
    const isFirstRep = priorReps === 0 || !(Number(fm.interval) > 0);

    let interval = isFirstRep
      ? priorityToInterval(priority)
      : Math.max(1, Math.round(Number(fm.interval) * aFactor));

    // Stall guard: no growth if read_point did not advance.
    if (s.stall_guard && !isFirstRep) {
      const advanced = topicCore.hasProgressAdvanced({
        previousPage: prevReadPoint,
        nextPage: newReadPoint ?? prevReadPoint,
        previousSeconds: prevReadSeconds,
        nextSeconds: newReadPointSeconds ?? prevReadSeconds,
        previousLine: previousReadPointLine,
        nextLine: newReadPointLine,
      });
      if (!advanced) interval = Math.min(interval, Number(fm.interval) || interval);
    }

    const nextReview = futureDateString(interval, this.settings);

    await this.app.fileManager.processFrontMatter(file, (fmw) => {
      fmw.interval = interval;
      fmw.review_count = reviewCount;
      fmw.next_review = nextReview;
      fmw.last_reviewed = today;
      fmw.a_factor = round4(aFactor);
      if (newReadPoint !== undefined && newReadPoint !== null) fmw.read_point = newReadPoint;
      if (newReadPointSeconds !== undefined && newReadPointSeconds !== null) fmw.read_point_seconds = newReadPointSeconds;
      if (newReadPointLine > 0) fmw.read_point_line = newReadPointLine;
      if (fmw.status === 'inbox' || fmw.status === 'pending') fmw.status = 'active';
      for (const k of ['stability', 'difficulty', 'last_grade', 'last_retrievability', 'ease']) {
        if (fmw[k] !== undefined) delete fmw[k];
      }
    });

    let markedDone = false;
    const chapterEnd = Number(fm.page_end) || null;
    const bookEnd = Number(fm.total_pages) || null;
    const target = chapterEnd || bookEnd;
    const vidTarget = Number(fm.total_seconds) || null;
    const reachedPages = fm.type === 'source' && target && newReadPoint != null && newReadPoint >= target;
    const reachedVideo = isVideo && vidTarget && newReadPointSeconds != null && newReadPointSeconds >= vidTarget;
    if (reachedPages || reachedVideo) {
      const unit = reachedVideo ? 'video' : (chapterEnd ? 'chapter' : 'source');
      const done = await confirmDialog(this.app, `Mark ${unit} as done?`);
      if (done) {
        await this.app.fileManager.processFrontMatter(file, (fmw) => { fmw.status = 'done'; });
        markedDone = true;
      }
    }

    // Keep the historical review-log columns stable. A-Factor before/after are
    // captured in the final columns for dashboard and script compatibility.
    const logFile = this.app.vault.getAbstractFileByPath(this.reviewLogPath());
    if (logFile) {
      const elapsedDays = (() => {
        const lr = parseDateValue(fm.last_reviewed, this.settings);
        const tdy = parseDateValue(today, this.settings);
        return (lr && tdy) ? Math.max(0, Math.round((tdy - lr) / 86400000)) : 0;
      })();
      const row = `| ${today} | [[${file.basename}]] | ${fm.type} | — | ${elapsedDays} |  |  |  | ${round4(priorAFactor)} | ${round4(aFactor)} |\n`;
      await this.app.vault.append(logFile, row);
    }

    const typeLabel = fm.type === 'source' ? 'Source' : 'Extract';
    const doneMsg = markedDone ? ' | DONE' : '';
    new Notice(`${typeLabel}: priority ${priority} a=${round4(aFactor)} → next in ${interval}d (${nextReview})${doneMsg}`);
  }

  // Adaptive A-Factor tuning per SM canon. Multiplies a_factor by `factor`,
  // clamped to [settings.a_factor_min, settings.a_factor_max], persists to
  // frontmatter, and returns { from, to } when the value actually moved.
  async _bumpAFactor(file, fm, factor) {
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract')) return null;
    const cur = readAFactor(this.settings, fm);
    const next = clampAFactor(this.settings, cur * factor);
    if (Math.abs(next - cur) < 0.005) return null;
    await this.app.fileManager.processFrontMatter(file, (fmw) => { fmw.a_factor = round4(next); });
    return { from: round4(cur), to: round4(next) };
  }

  // ---- Sidebar queue + checkpoints ---------------------------------------

  async _activateQueueView() {
    if (!this.settings.queue.sidebar_enabled) {
      new Notice('Sidebar disabled in Incremental Reading Toolkit settings');
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType(IR_QUEUE_VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: IR_QUEUE_VIEW_TYPE });
    this.app.workspace.revealLeaf(leaf);
  }

  async _activateKnowledgeTree() {
    const existing = this.app.workspace.getLeavesOfType(KNOWLEDGE_TREE_VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: KNOWLEDGE_TREE_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async _activateKnowledgeTreeSidebar() {
    const existing = this.app.workspace.getLeavesOfType(KNOWLEDGE_TREE_SIDEBAR_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeftLeaf(false);
    await leaf.setViewState({ type: KNOWLEDGE_TREE_SIDEBAR_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  _refreshTreeViews() {
    for (const t of [KNOWLEDGE_TREE_VIEW_TYPE, KNOWLEDGE_TREE_SIDEBAR_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(t)) {
        const v = leaf.view;
        if (v && typeof v._renderBody === 'function') v._renderBody();
        else if (v && typeof v._render === 'function') v._render();
      }
    }
  }

  isExpanded(key) { return (this.settings.tree.expanded || []).includes(key); }

  toggleExpanded(key) {
    const arr = this.settings.tree.expanded || (this.settings.tree.expanded = []);
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    this.saveSettings();
  }

  // Build the tree index from every IR element. Duplicate basenames stay visible
  // as roots and cannot be used as parents until the user gives them unique names.
  buildTreeIndex() {
    const pages = [];
    for (const f of getAllIRFiles(this.app, this.settings)) {
      const fm = getFm(this.app, f);
      if (!fm) continue;
      const t = fm.type;
      if (t !== 'category' && t !== 'source' && t !== 'extract' && t !== 'card') continue;
      pages.push({ path: f.path, basename: f.basename, fm, tfile: f });
    }
    return treeCore.buildTreeIndex(pages);
  }

  async createCategory(parentName = null) {
    const name = await askText(this.app, 'Category name', '');
    if (!name) return null;
    const safe = slugifyForFolder(name);
    if (!safe) { new Notice('Invalid category name'); return null; }
    await ensureFolder(this.app, CATEGORIES_FOLDER);
    const path = `${CATEGORIES_FOLDER}/${safe}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('Category already exists'); return null; }
    const fm = ['---', 'type: category'];
    if (parentName) fm.push(`parent: ${JSON.stringify(`[[${parentName}]]`)}`);
    fm.push('tree_order: 0', 'tags:', '  - incremental-reading', '  - ir/category', '---', '', `# ${name}`, '');
    const file = await this.app.vault.create(path, fm.join('\n'));
    new Notice(`Category created: ${name}`);
    return file;
  }

  async reparent(childPath, newParentName) {
    const child = this.app.vault.getAbstractFileByPath(childPath);
    if (!child) { new Notice('Node not found'); return; }
    const idx = this.buildTreeIndex();
    if (newParentName && idx.duplicates.has(newParentName.toLowerCase())) {
      new Notice(`Refused: more than one node is named "${newParentName}"`); return;
    }
    if (newParentName && treeCore.wouldCreateCycle(idx, child.basename, newParentName)) {
      new Notice('Refused: would create a cycle'); return;
    }
    await this.app.fileManager.processFrontMatter(child, (fm) => {
      if (newParentName) {
        fm.parent = `[[${newParentName}]]`;
        delete fm.tree_root;
      } else {
        delete fm.parent;
        fm.tree_root = true;
      }
    });
    new Notice(newParentName ? `Moved under ${newParentName}` : 'Moved to top level');
    this._refreshTreeViews();
  }

  async reparentActive() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('No active markdown element'); return; }
    const fm = getFm(this.app, active);
    if (!fm || !['category', 'source', 'extract', 'card'].includes(fm.type)) {
      new Notice('Active note is not an incremental reading element'); return;
    }
    const idx = this.buildTreeIndex();
    const candidates = idx.pages.filter(p =>
      p.fm.type !== 'card' && p.path !== active.path && !idx.duplicates.has(p.basename.toLowerCase()));
    const displays = candidates.map(p => `${TREE_ICONS[p.fm.type] || '•'} ${p.basename}`);
    const values = candidates.map(p => p.basename);
    displays.unshift('⤴ (top level / Unfiled)');
    values.unshift('::root::');
    const picked = await pickFromList(this.app, displays, values, 'Move under…');
    if (picked == null) return;
    await this.reparent(active.path, picked === '::root::' ? null : picked);
  }

  async reorderSibling(path, dir) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return;
    const idx = this.buildTreeIndex();
    const page = idx.byName.get(f.basename.toLowerCase());
    if (!page) return;
    const parentName = treeCore.effectiveParent(page.fm);
    let siblings;
    if (parentName) {
      siblings = idx.childrenOf.get(parentName.toLowerCase()) || [];
    } else {
      // Root level renders in two visual groups: top-level categories, and the
      // Unfiled bucket (everything else). Reorder within the moved node's own group
      // so ↑/↓ matches what the user sees.
      const isCatRoot = (p) => p.fm.type === 'category' && !treeCore.effectiveParent(p.fm);
      const movedIsCatRoot = isCatRoot(page);
      siblings = idx.roots.filter(p => isCatRoot(p) === movedIsCatRoot);
    }
    const order = siblings.map(s => ({ path: s.path, tree_order: s.fm && s.fm.tree_order }));
    const curIdx = order.findIndex(s => s.path === path);
    if (curIdx < 0) return;
    const targetIndex = curIdx + dir;
    if (targetIndex < 0 || targetIndex >= order.length) return;
    const writes = treeCore.computeReorder(order, path, targetIndex);
    for (const w of writes) {
      const tf = this.app.vault.getAbstractFileByPath(w.path);
      if (tf) await this.app.fileManager.processFrontMatter(tf, (fm) => { fm.tree_order = w.tree_order; });
    }
    this._refreshTreeViews();
  }

  async renameTreeNode(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return;
    const next = await askText(this.app, 'New name', f.basename);
    if (!next || next === f.basename) return;
    const safe = slugifyForFolder(next);
    if (!safe) { new Notice('Invalid name'); return; }
    const dir = f.parent ? f.parent.path : '';
    const newPath = (dir ? dir + '/' : '') + safe + '.md';
    if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice('A file with that name exists'); return; }
    await this.app.fileManager.renameFile(f, newPath);
    new Notice(`Renamed to ${safe}`);
    this._refreshTreeViews();
  }

  async dismissTreeNode(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return;
    if (getFm(this.app, f)?.type === 'card') {
      new Notice('Card review state is managed by Spaced Repetition.');
      return;
    }
    const ok = await confirmDialog(this.app, `Dismiss "${f.basename}"?`,
      'Sets status: dismissed (kept in the tree, removed from the review queue).');
    if (!ok) return;
    await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = 'dismissed'; });
    new Notice('Dismissed');
    this._refreshTreeViews();
  }

  async seedInlineCards() {
    const active = this.app.workspace.getActiveFile();
    if (!active) { new Notice('No active file'); return; }
    const cache = this.app.metadataCache.getFileCache(active);
    const fm = cache?.frontmatter;
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract')) {
      new Notice('Active file is not a source/extract');
      return;
    }
    const body = await this.app.vault.cachedRead(active);
    const parsed = parseInlineCards(active.path, body, this.settings);
    if (!parsed.length) { new Notice('No inline cards found'); return; }

    const grouped = new Map();
    for (const card of parsed) {
      const key = card.type === 'qa' ? card.id : inlineCardId(active.path, `line:${card.line}:${card.full_line}`);
      if (!grouped.has(key)) grouped.set(key, card);
    }
    const existingIds = new Set();
    for (const file of filesInFolder(this.app, this.cardsFolder())) {
      if (file.extension !== 'md') continue;
      const id = getFm(this.app, file)?.ir_inline_id;
      if (id) existingIds.add(String(id));
    }

    let created = 0;
    const clozeRegex = new RegExp(this.settings.inline_cards.cloze_regex, 'g');
    for (const [id, card] of grouped) {
      if (existingIds.has(id)) continue;
      let format = card.type === 'qa' ? 'basic' : 'cloze';
      let question = card.question;
      let answer = card.answer || '';
      if (format === 'cloze') {
        question = card.full_line.replace(clozeRegex, (_match, _index, text, hint) =>
          `==${text}==${hint ? `^[${hint}]` : ''}`
        );
      }
      await this._createSpacedRepetitionCard(active, {
        format,
        question,
        answer,
        extraFrontmatter: [`ir_inline_id: ${JSON.stringify(id)}`],
      });
      existingIds.add(id);
      created++;
    }
    new Notice(created
      ? `Exported ${created} inline card${created === 1 ? '' : 's'} to Spaced Repetition`
      : 'All inline cards are already exported');
  }

  async addCheckpoint(noteOverride) {
    const active = this.app.workspace.getActiveFile();
    if (!active) { new Notice('No active file'); return; }
    const cache = this.app.metadataCache.getFileCache(active);
    if (!isActiveIR(cache?.frontmatter) || cache.frontmatter.type === 'card') {
      new Notice('Checkpoints apply to sources and extracts only.'); return;
    }

    let note = noteOverride;
    if (note == null) {
      note = await new Promise(resolve => {
        new TextPromptModal(this.app, 'Checkpoint note (prefix with Nd:: to override interval)', '', resolve).open();
      });
    }
    if (note == null) return;

    const editor = this.app.workspace.activeEditor?.editor;
    const line = editor ? editor.getCursor().line : 0;

    let interval = null;
    let cleanNote = note;
    const m = note.match(/^(\d+)d::\s*(.*)$/);
    if (m) { interval = Number(m[1]); cleanNote = m[2]; }

    await this.app.fileManager.processFrontMatter(active, (fm) => {
      fm.checkpoints = fm.checkpoints || [];
      fm.checkpoints.push({
        date: todayDateString(this.settings),
        line,
        note: cleanNote,
        ...(fm.type === 'source' && fm.read_point_seconds != null ? { read_point_seconds: fm.read_point_seconds } : {}),
      });
      if (interval != null) {
        fm.interval = interval;
        fm.next_review = futureDateString(interval, this.settings);
      }
    });

    new Notice(interval != null ? `Checkpoint saved, next in ${interval}d` : 'Checkpoint saved');
  }

  // ---- Done / Dismiss / Postpone / Schedule ------------------------------

  async markDone() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const { tfile, fm } = r;
    if (fm.status === 'done') { new Notice('Already done.'); return; }
    const labels = { source: 'Source', extract: 'Extract' };
    if (!(await confirmDialog(this.app, `Mark ${labels[fm.type]} as done?`))) return;
    await this.app.fileManager.processFrontMatter(tfile, (fmw) => {
      fmw.status = 'done';
      fmw.last_reviewed = todayDateString(this.settings);
    });
    new Notice(`${labels[fm.type]} marked done.`);
  }

  async dismiss() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const { tfile, fm } = r;
    if (fm.status === 'dismissed') { new Notice('Already dismissed.'); return; }
    await this.app.fileManager.processFrontMatter(tfile, (fmw) => {
      fmw.status = 'dismissed';
      fmw.date_dismissed = todayDateString(this.settings);
    });
    new Notice('Dismissed. Set status: active to restore.');
  }

  async postpone() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const choice = await pickFromList(
      this.app,
      ['Tomorrow (+1d)', '+3 days', '+1 week', '+2 weeks'],
      [1, 3, 7, 14],
      'Postpone how long?'
    );
    if (!choice) return;
    const newDate = futureDateString(choice, this.settings);
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      fmw.next_review = newDate;
      fmw.interval = choice;
    });
    new Notice(`Postponed +${choice}d · Next review: ${newDate}`);
  }

  async schedule() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const cur = r.fm.next_review || '(unscheduled)';
    const dateFormat = configuredDateFormat(this.settings);
    const raw = await askText(this.app, `Schedule (${dateFormat} or +Nd/-Nd; current: ${cur})`, '');
    if (!raw || raw.trim() === '') return;
    const input = raw.trim();

    let newDate = null;
    const offset = input.match(/^([+-]?)(\d+)\s*d?$/i);
    if (offset) {
      const sign = offset[1] === '-' ? -1 : 1;
      newDate = futureDateString(sign * parseInt(offset[2], 10), this.settings);
    } else {
      const parsed = dateCore.parseDateExact(input, dateFormat);
      if (!parsed) { new Notice(`Invalid ${dateFormat} date: ${input}`); return; }
      newDate = formatDateValue(parsed, this.settings);
    }
    const newParsed = parseDateValue(newDate, this.settings);
    const newInterval = newParsed ? Math.max(1, Math.round((newParsed - todayDate()) / 86400000)) : null;
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      fmw.next_review = newDate;
      if (newInterval != null) fmw.interval = newInterval;
    });
    new Notice(`Scheduled: ${cur} → ${newDate}`);
  }

  // ---- Set Priority / Boost ---------------------------------------------

  async setPriority() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const cur = r.fm.priority ?? 50;
    const raw = await askText(this.app, 'New priority (1-100, 1=highest)', String(cur));
    if (raw === null) return;
    const p = parseInt(raw, 10);
    if (isNaN(p) || p < 1 || p > 100) { new Notice('Invalid priority — integer 1-100.'); return; }
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => { fmw.priority = p; });
    new Notice(`Priority → ${p} (next_review unchanged — A-Factor-driven)`);
  }

  async boost() {
    const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
    if (!r) return;
    const amount = await pickFromList(
      this.app,
      ['Small (-5)', 'Medium (-15)', 'Strong (-30)', 'Custom'],
      [5, 15, 30, 'custom'],
      'Boost amount'
    );
    if (!amount) return;
    let delta;
    if (amount === 'custom') {
      const raw = await askText(this.app, 'Boost amount (1-99)', '10');
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 99) { new Notice('Invalid amount.'); return; }
      delta = n;
    } else { delta = amount; }

    const cascade = await confirmDialog(this.app, 'Cascade boost to all descendants in subtree?');
    const orig = r.fm.priority ?? 50;
    const newPri = Math.max(1, orig - delta);
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      if (fmw.boost_from == null) fmw.boost_from = orig;
      fmw.priority = newPri;
    });

    let cascaded = 0;
    if (cascade) {
      const subtree = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path);
      for (const p of subtree) {
        if (p.tfile.path === r.tfile.path) continue;
        if (p.fm.type === 'card') continue;
        const childOrig = p.fm.priority ?? 50;
        const childNew = Math.max(1, childOrig - delta);
        if (childNew !== childOrig) {
          await this.app.fileManager.processFrontMatter(p.tfile, (fmw) => {
            if (fmw.boost_from == null) fmw.boost_from = childOrig;
            fmw.priority = childNew;
          });
          cascaded++;
        }
      }
    }
    const cmsg = cascade ? ` + ${cascaded} descendant${cascaded === 1 ? '' : 's'}` : '';
    new Notice(`Boosted: ${orig} → ${newPri}${cmsg}. boost_from preserved.`);
  }

  // ---- Subset Review / Mercy / Postpone Subtree --------------------------

  async subsetReview() {
    const r = await resolveSourceFromActive(this.app, this.settings);
    if (!r) return;
    const filter = await pickFromList(
      this.app,
      ['All topics', 'Due / overdue only'],
      ['all', 'due'],
      'Filter subtree by'
    );
    if (!filter) return;

    const today = todayDate();
    let subset = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path, { includeCards: false })
      .filter(p => p.tfile.path !== r.tfile.path);
    if (filter === 'due') subset = subset.filter(p => isDue(p.fm, today, this.settings));
    subset = subset.filter(p => p.fm.status !== 'done' && p.fm.status !== 'container' && p.fm.status !== 'dismissed');
    if (subset.length === 0) { new Notice(`No descendants match.`); return; }

    subset.sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
    const statusIcon = (fm) => {
      const nr = parseDateValue(fm.next_review, this.settings);
      if (!nr) return '⚪';
      const off = daysBetween(today, nr);
      return off > 0 ? '🔴' : (off === 0 ? '🟡' : '🟢');
    };
    const picked = await pickFuzzy(
      this.app,
      subset,
      p => {
        const t = p.fm.type === 'source' ? '📖' : '📝';
        return `${t} ${statusIcon(p.fm)} p${p.fm.priority ?? '—'} u${urgency(p.fm, today, this.settings).toFixed(0)}  ${p.tfile.basename}`;
      },
      `Subset (${r.tfile.basename})`
    );
    if (!picked) return;
    await this.app.workspace.getLeaf(false).openFile(picked.tfile);
  }

  async mercy() {
    const choice = await pickFromList(
      this.app, ['3 days', '7 days', '14 days', '30 days'], [3, 7, 14, 30], 'Spread window'
    );
    if (!choice) return;
    const today = todayDate();
    const overdue = [];
    for (const f of getAllIRFiles(this.app, this.settings)) {
      const fm = getFm(this.app, f);
      if (!isActiveIR(fm) || fm.type === 'card') continue;
      if (!isPastDue(fm, today, this.settings)) continue;
      overdue.push({ tfile: f, fm });
    }
    if (overdue.length === 0) { new Notice('Nothing overdue.'); return; }
    overdue.sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
    let updated = 0;
    for (let rank = 0; rank < overdue.length; rank++) {
      const off = Math.floor(rank * choice / overdue.length);
      const d = new Date(today.getTime()); d.setDate(d.getDate() + off);
      const newDate = formatDateValue(d, this.settings);
      await this.app.fileManager.processFrontMatter(overdue[rank].tfile, (fmw) => { fmw.next_review = newDate; fmw.interval = Math.max(1, off); });
      updated++;
    }
    new Notice(`Mercy: ${updated} overdue spread across ${choice}d.`);
  }

  async postponeSubtree() {
    const r = await resolveSourceFromActive(this.app, this.settings);
    if (!r) return;
    const choice = await pickFromList(
      this.app,
      ['+1d', '+3d', '+1 week', '+2 weeks', '+1 month'],
      [1, 3, 7, 14, 30],
      'Postpone subtree by'
    );
    if (!choice) return;
    const subtree = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path);
    let postponed = 0;
    for (const p of subtree) {
      const fm = p.fm;
      if (fm.type === 'card') continue;
      if (fm.status === 'done' || fm.status === 'container' || fm.status === 'dismissed') continue;
      let baseDate = todayDateString(this.settings);
      if (fm.next_review) {
        const candidate = parseDateValue(fm.next_review, this.settings);
        if (candidate && candidate > todayDate()) baseDate = fm.next_review;
      }
      const baseObj = parseDateValue(baseDate, this.settings) || todayDate();
      baseObj.setDate(baseObj.getDate() + choice);
      const newDate = formatDateValue(baseObj, this.settings);
      await this.app.fileManager.processFrontMatter(p.tfile, (fmw) => { fmw.next_review = newDate; });
      postponed++;
    }
    new Notice(`Subtree postponed +${choice}d · ${postponed} element${postponed === 1 ? '' : 's'}.`);
  }

  // ---- Extract / Flashcard ------------------------------------------------

  async extractClipboard() {
    await this._createExtract(true);
  }

  async extractSelection() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') {
      new Notice('Extract Selection requires an open markdown source.');
      return;
    }
    const fm = getFm(this.app, active);
    if (fm?.type !== 'source') { new Notice('Run from a source note.'); return; }
    const editor = getEditorForFile(this.app, active);
    const selection = editor?.getSelection?.() || '';
    if (!selection.trim()) { new Notice('No text selected.'); return; }
    await this._writeExtract(active, fm, selection.trim());
  }

  async _createExtract(fromClipboard) {
    const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
    if (!r) return;
    let clip = '';
    try { clip = (await navigator.clipboard.readText()).trim(); }
    catch (e) { new Notice('Could not read clipboard.'); return; }
    if (!clip) { new Notice('Clipboard empty.'); return; }
    await this._writeExtract(r.tfile, r.fm, clip);
  }

  async _writeExtract(sourceFile, fm, body) {
    const sourceTitle = sourceFile.basename;
    const safeSourceTitle = slugifyForFolder(sourceTitle) || 'Untitled';
    const extractsFolder = this.extractsFolder();
    await ensureFolder(this.app, extractsFolder);
    const priority = fm.priority ?? 50;
    const today = todayDateString(this.settings);
    const existing = filesInFolder(this.app, extractsFolder).filter(f =>
      f.extension === 'md' && f.basename.startsWith(safeSourceTitle + ' - Extract'));
    let n = existing.length + 1;
    let name = `${safeSourceTitle} - Extract ${n}`;
    while (this.app.vault.getAbstractFileByPath(`${extractsFolder}/${name}.md`)) {
      name = `${safeSourceTitle} - Extract ${++n}`;
    }
    const autoInterval = priorityToInterval(priority);

    const customStr = await askText(this.app, `First interval in days (blank for auto: ${autoInterval}d)`, '');
    const interval = (customStr && Number.isFinite(Number(customStr)))
      ? Math.max(1, Math.round(Number(customStr))) : autoInterval;
    const nextReview = futureDateString(interval, this.settings);

    const content = `---
type: extract
source: ${JSON.stringify(`[[${sourceTitle}]]`)}
status: pending
priority: ${priority}
next_review: ${nextReview}
interval: ${interval}
a_factor: 2.0
review_count: 0
last_reviewed:
date_added: ${today}
tags:
  - incremental-reading
  - ir/extract
---

${body}
`;
    const path = `${extractsFolder}/${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Extract already exists at ${path}`); return;
    }
    await this.app.vault.create(path, content);
    const decayCap = Math.min(100, priority + 30);
    const newPri = Math.min(decayCap, priority + 1);
    if (newPri !== priority) {
      await this.app.fileManager.processFrontMatter(sourceFile, (fmw) => { fmw.priority = newPri; });
    }
    const bump = await this._bumpAFactor(sourceFile, fm, this.settings.scheduling.extract_bump);
    const bumpMsg = bump ? ` · a ${bump.from}→${bump.to}` : '';
    new Notice(`Extract: ${name} · p${priority}→${newPri} · review +${interval}d (${nextReview})${bumpMsg}`);
  }

  async flashcardClipboard() {
    this._dbg('flashcardClipboard start');
    const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
    if (!r) return;
    const parentFile = r.tfile;
    const fm = r.fm;

    // Image clipboard branch: build image-based card with prompted answer.
    const imgClip = await readImageFromClipboard();
    if (imgClip) {
      return await this._flashcardFromImage(parentFile, fm, { imgClip });
    }

    let clip = '';
    try { clip = (await navigator.clipboard.readText()).trim(); }
    catch (e) { new Notice('Could not read clipboard.'); return; }
    if (!clip) { new Notice('Clipboard empty (no text or image).'); return; }
    this._dbg('flashcard: clip length', clip.length, 'inline-match', /^[^\n]+::[^\n]+$/.test(clip));

    const parentTitle = parentFile.basename;
    let cardFormat = null, questionText = null, answerText = null;

    const COLON = ':';
    const inlineRe = new RegExp(`^[^\\n]+${COLON}${COLON}[^\\n]+$`);
    if (inlineRe.test(clip) && !clip.includes('\n')) {
      const parts = clip.split(COLON + COLON);
      questionText = parts[0].trim();
      answerText = parts.slice(1).join(COLON + COLON).trim();
      cardFormat = 'basic';
    } else if (/\n\?\n/.test(clip)) {
      const parts = clip.split(/\n\?\n/);
      questionText = parts[0].trim();
      answerText = parts.slice(1).join('\n?\n').trim();
      cardFormat = 'basic';
    } else {
      cardFormat = await pickFromList(
        this.app,
        ['Cloze deletion (Wozniak rule 5 — recommended)',
         'Basic Q&A (question + hidden answer)',
         'Basic reversed (vocab pair)'],
        ['cloze', 'basic', 'reverse'],
        'Card format'
      );
      this._dbg('flashcard: cardFormat =', JSON.stringify(cardFormat));
      if (!cardFormat) return;
      if (cardFormat === 'cloze') {
        this._dbg('flashcard: about to open cloze keyword prompt');
        const kw = await askText(this.app, 'Word(s) to cloze (comma-separated; empty = manual edit)', '');
        this._dbg('flashcard: kw returned =', JSON.stringify(kw));
        if (kw === null) return;
        let text = clip;
        const keywords = kw.split(',').map(w => w.trim()).filter(Boolean);
        const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (keywords.length) {
          const missing = [];
          for (const w of keywords) {
            const re = new RegExp(`\\b${escape(w)}\\b`);
            if (!re.test(text)) { missing.push(w); continue; }
            text = text.replace(re, `==${w}==`);
          }
          if (missing.length === keywords.length) {
            const edited = await askText(this.app, 'Edit text — wrap word(s) with ==marks==', clip);
            if (!edited) return;
            text = edited;
          }
        } else {
          const edited = await askText(this.app, 'Edit text — wrap word(s) with ==marks==', clip);
          if (!edited) return;
          text = edited;
        }
        if (!new RegExp(HL_CLOZE_SRC).test(text)) { new Notice('No ==marks== — aborted.'); return; }
        questionText = text;
      } else {
        answerText = await askText(this.app, 'Answer (rule 4: keep it short)', '');
        if (!answerText || !answerText.trim()) return;
        questionText = clip.replace(/\n+/g, ' ');
        answerText = answerText.trim();
      }
    }

    if (cardFormat !== 'cloze') {
      const prefix = await askText(this.app, "Context label (optional, e.g. 'bioch:' — rule 16)", '');
      if (prefix === null) return;
      if (prefix.trim()) {
        const pfx = prefix.trim().replace(/:?\s*$/, ':');
        questionText = `${pfx} ${questionText}`;
      }
    }

    const created = await this._createSpacedRepetitionCard(parentFile, {
      format: cardFormat,
      question: questionText,
      answer: answerText,
    });
    const kind = cardFormat === 'reverse' ? 'Bidirectional card' : (cardFormat === 'cloze' ? 'Cloze card' : 'Card');
    new Notice(`${kind} created for Spaced Repetition: ${created.name}`);
  }

  // Build a basic image-based flashcard (image is the question, user supplies
  // text answer). Image saved into the parent's attachment folder, embedded
  // via vault-relative wikilink. Pass either { imgClip } (binary from clipboard)
  // or { vaultPath } (existing image already in vault). skipCaption=true omits
  // the caption prompt — used for the pure "name this image" flashcard type.
  async _flashcardFromImage(parentFile, fm, { imgClip, vaultPath, skipCaption } = {}) {
    const parentTitle = parentFile.basename;

    let imgPath;
    if (imgClip) {
      const ext = imgClip.mime === 'image/jpeg' ? 'jpg'
        : (imgClip.mime === 'image/webp' ? 'webp' : 'png');
      const attachDir = `${ATTACHMENTS_FOLDER}/${slugifyForFolder(parentTitle)}`;
      await ensureFolder(this.app, attachDir);
      const hash = await shortHashOfBytes(imgClip.bytes);
      imgPath = `${attachDir}/img-${hash}.${ext}`;
      if (!this.app.vault.getAbstractFileByPath(imgPath)) {
        await this.app.vault.createBinary(imgPath, imgClip.bytes);
      }
    } else if (vaultPath) {
      imgPath = vaultPath;
    } else {
      new Notice('No image provided.');
      return;
    }

    let caption = '';
    if (!skipCaption) {
      caption = await askText(this.app, 'Question caption (optional, shown above image)', '');
      if (caption === null) return;
    }
    const answer = await askText(this.app, 'Answer — name what this is', '');
    if (answer === null || !answer.trim()) { new Notice('Answer required.'); return; }

    const questionText = caption && caption.trim()
      ? `${caption.trim()}\n![[${imgPath}]]`
      : `![[${imgPath}]]`;
    const answerText = answer.trim();
    const created = await this._createSpacedRepetitionCard(parentFile, {
      format: 'basic',
      question: questionText,
      answer: answerText,
    });
    new Notice(`Image card created for Spaced Repetition: ${created.name}`);
  }

  // "Name this image" flashcard: image is the only thing on the front,
  // user types the name on the back. Pulls image from clipboard if present,
  // otherwise picks from the parent's embedded images or attachment folder.
  async flashcardImageName() {
    const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
    if (!r) return;

    const imgClip = await readImageFromClipboard();
    if (imgClip) {
      return await this._flashcardFromImage(r.tfile, r.fm, { imgClip, skipCaption: true });
    }

    const fileContent = await this.app.vault.read(r.tfile);
    const linkRe = /!\[\[([^\]|#]+\.(?:png|jpe?g|webp|gif))(?:[#|][^\]]*)?\]\]/gi;
    const linked = Array.from(fileContent.matchAll(linkRe)).map(m => m[1].trim());

    const parentBase = (r.fm.type === 'source')
      ? r.tfile.basename
      : (() => {
          const link = String(r.fm.source || '').match(/\[\[([^\]|#]+)/);
          return link ? link[1] : r.tfile.basename;
        })();
    const attachDir = `${ATTACHMENTS_FOLDER}/${slugifyForFolder(parentBase)}`;
    const folderFiles = filesInFolder(this.app, attachDir).filter(f =>
      f.path.startsWith(attachDir + '/') && /\.(png|jpe?g|webp|gif)$/i.test(f.name));

    const candidates = new Map();
    for (const path of linked) {
      const tf = this.app.vault.getAbstractFileByPath(path)
        || this.app.metadataCache.getFirstLinkpathDest(path, r.tfile.path);
      if (tf) candidates.set(tf.path, tf);
    }
    for (const f of folderFiles) candidates.set(f.path, f);

    const list = Array.from(candidates.values());
    if (list.length === 0) {
      new Notice('No image on clipboard and no images linked to this note.');
      return;
    }

    const picked = list.length === 1
      ? list[0]
      : await pickFuzzy(this.app, list, f => f.path, 'Pick image to name');
    if (!picked) return;

    return await this._flashcardFromImage(r.tfile, r.fm, { vaultPath: picked.path, skipCaption: true });
  }

  // ---- Image extract / Occlusion (visual learning) -----------------------

  async imageExtractClipboard() {
    const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
    if (!r) return;

    const sourceFolder = slugifyForFolder(r.tfile.basename);
    const attachDir = `${ATTACHMENTS_FOLDER}/${sourceFolder}`;

    // Two clipboard formats supported:
    //   1. binary image (e.g. screen-capture, Preview.app copy)
    //   2. text containing ![[<image-in-vault>]] (PDF++ auto-copy after
    //      rectangular selection on a PDF). PDF++ writes the image to its
    //      configured attachment folder and copies the embed link.
    let bytes = null, ext = null;

    const img = await readImageFromClipboard();
    if (img) {
      bytes = img.bytes;
      ext = img.mime === 'image/jpeg' ? 'jpg' : (img.mime === 'image/webp' ? 'webp' : 'png');
    } else {
      let clipText = '';
      try { clipText = (await navigator.clipboard.readText()).trim(); } catch (e) { /* no perm */ }
      const wikilinkMatch = clipText.match(/!\[\[([^\]|#]+\.(?:png|jpe?g|webp|gif))(?:[#|][^\]]*)?\]\]/i);
      const mdLinkMatch = clipText.match(/!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|webp|gif))\)/i);
      const linkPath = wikilinkMatch?.[1] || mdLinkMatch?.[1] || null;
      if (!linkPath) {
        new Notice('No image on clipboard. With PDF++: enable "Rectangular selection" + "Auto-copy", drag rect, then run this command.');
        return;
      }
      const sourceTf = this.app.vault.getAbstractFileByPath(linkPath)
        || this.app.metadataCache.getFirstLinkpathDest(linkPath, r.tfile.path);
      if (!sourceTf) { new Notice(`Image not found in vault: ${linkPath}`); return; }
      bytes = await this.app.vault.readBinary(sourceTf);
      ext = (sourceTf.extension || 'png').toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
    }

    await ensureFolder(this.app, attachDir);
    const hash = await shortHashOfBytes(bytes);
    const imgPath = `${attachDir}/img-${hash}.${ext}`;

    if (!this.app.vault.getAbstractFileByPath(imgPath)) {
      await this.app.vault.createBinary(imgPath, bytes);
    }

    const caption = await askText(this.app, 'Caption (optional, used as extract body)', '');
    if (caption === null) return;
    const body = caption.trim()
      ? `![[${imgPath}]]\n\n${caption.trim()}`
      : `![[${imgPath}]]`;

    await this._writeExtract(r.tfile, r.fm, body);
  }

  async occlusionCreate() {
    const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
    if (!r) return;

    const fileContent = await this.app.vault.read(r.tfile);
    const linkRe = /!\[\[([^\]|#]+\.(?:png|jpg|jpeg|webp|gif))(?:[#|][^\]]*)?\]\]/gi;
    const linked = [];
    let m;
    while ((m = linkRe.exec(fileContent))) linked.push(m[1].trim());

    let imgVaultPath = null;
    if (linked.length === 1) {
      imgVaultPath = linked[0];
    } else if (linked.length > 1) {
      imgVaultPath = await pickFromList(this.app, linked, linked, 'Pick image to occlude');
      if (!imgVaultPath) return;
    } else {
      const parentBase = (r.fm.type === 'source')
        ? r.tfile.basename
        : (() => {
            const link = String(r.fm.source || '').match(/\[\[([^\]|#]+)/);
            return link ? link[1] : r.tfile.basename;
          })();
      const dir = `${ATTACHMENTS_FOLDER}/${slugifyForFolder(parentBase)}`;
      const folder = this.app.vault.getAbstractFileByPath(dir);
      if (!folder) {
        new Notice('No images for this source. Use Image-extract (Mod+Shift+K) first or embed an image.');
        return;
      }
      const files = filesInFolder(this.app, dir).filter(f =>
        f.path.startsWith(dir + '/') && /\.(png|jpe?g|webp|gif)$/i.test(f.name));
      if (files.length === 0) { new Notice('No images in attachment folder.'); return; }
      const picked = await pickFuzzy(this.app, files, f => f.name, 'Pick image');
      if (!picked) return;
      imgVaultPath = picked.path;
    }

    const tf = this.app.vault.getAbstractFileByPath(imgVaultPath)
      || this.app.metadataCache.getFirstLinkpathDest(imgVaultPath, r.tfile.path);
    if (!tf) { new Notice(`Image not found: ${imgVaultPath}`); return; }
    const resolvedPath = tf.path;
    const src = this.app.vault.adapter.getResourcePath(resolvedPath);

    const result = await askOcclusion(this.app, src);
    if (!result) return;

    const cardSpecs = generateCardsFromRects(result.rects, result.mode);
    if (!cardSpecs || cardSpecs.length === 0) { new Notice('No cards generated.'); return; }

    let written = 0;

    const yamlRects = result.rects
      .map(rect => {
        const base = `x: ${round4(rect.x)}, y: ${round4(rect.y)}, w: ${round4(rect.w)}, h: ${round4(rect.h)}`;
        const label = rect.label ? `, label: "${String(rect.label).replace(/"/g, '\\"')}"` : '';
        return `  - {${base}${label}}`;
      })
      .join('\n');

    for (const spec of cardSpecs) {
      const question = '```ir-occlusion\n' +
        `image: ${JSON.stringify(resolvedPath)}\n` +
        `mode: ${result.mode}\n` +
        `question_index: ${spec.questionIndex}\n` +
        'rects:\n' + yamlRects + '\n' +
        '```\n';
      await this._createSpacedRepetitionCard(r.tfile, {
        format: 'occlusion',
        question,
        answer: `![[${resolvedPath}]]`,
        extraFrontmatter: [
          `occlusion_image: ${JSON.stringify(resolvedPath)}`,
          `occlusion_mode: ${result.mode}`,
          `occlusion_question_index: ${spec.questionIndex}`,
        ],
      });
      written++;
    }

    new Notice(`Occlusion: ${written} Spaced Repetition card(s) from ${result.rects.length} rect(s)`);
  }

  // ---- New source / Import clipping --------------------------------------

  async newSource() {
    const title = await askText(this.app, 'Source title', '');
    if (!title) return;
    const sourceType = await pickFromList(
      this.app,
      ['Book', 'Article', 'PDF', 'YouTube video', 'Local video file'],
      ['book', 'article', 'pdf', 'youtube', 'video'],
      'Source type'
    );
    if (!sourceType) return;
    const priStr = await askText(this.app, 'Priority (1-100, 1=highest)', '50');
    if (priStr === null) return;
    const pNum = parseInt(priStr, 10);
    if (!Number.isFinite(pNum) || pNum < 1 || pNum > 100) {
      new Notice('Invalid priority — enter an integer from 1 to 100.'); return;
    }

    const today = todayDateString(this.settings);
    const interval = priorityToInterval(pNum);
    const nextReview = futureDateString(interval, this.settings);

    let sioyek_path = null, total_pages = null, read_point = null, source_url = null;
    let video_id = null, video_url = null, video_path = null, author = null;
    let read_point_seconds = null, total_seconds = null;

    if (sourceType === 'book' || sourceType === 'pdf') {
      sioyek_path = await askText(this.app, 'Absolute path to PDF/epub', '');
      if (sioyek_path) sioyek_path = sioyek_path.replace(/^['"]|['"]$/g, '');
      const pages = await askText(this.app, 'Total pages', '');
      total_pages = pages ? parseInt(pages, 10) : null;
      read_point = 1;
    } else if (sourceType === 'article') {
      source_url = (await askText(this.app, 'Source URL (optional)', '')) || null;
    } else if (sourceType === 'youtube') {
      video_url = await askText(this.app, 'YouTube URL', '');
      if (!video_url) { new Notice('YouTube URL required.'); return; }
      const m = video_url.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
      if (!m) { new Notice('Bad YouTube URL.'); return; }
      video_id = m[1];
      author = (await askText(this.app, 'Author / channel (optional)', '')) || null;
      const dur = await askText(this.app, 'Total duration mm:ss or hh:mm:ss (optional)', '');
      total_seconds = parseTimeInput(dur);
      read_point_seconds = 0;
    } else if (sourceType === 'video') {
      const videosFolder = `${this.sourcesFolder()}/Videos`;
      const videos = filesInFolder(this.app, videosFolder)
        .filter(f => f.path.startsWith(videosFolder + '/') && /\.(mp4|webm|mov|mkv)$/i.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (videos.length === 0) {
        new Notice(`Drop a video into ${videosFolder}/ first.`); return;
      }
      const picked = await pickFuzzy(this.app, videos, v => v.name, 'Pick a video file');
      if (!picked) return;
      video_path = picked.path;
      author = (await askText(this.app, 'Author (optional)', '')) || null;
      const dur = await askText(this.app, 'Total duration mm:ss or hh:mm:ss (optional)', '');
      total_seconds = parseTimeInput(dur);
      read_point_seconds = 0;
    }

    const holdInInbox = await confirmDialog(this.app, 'Hold in inbox? (Otherwise enters queue on schedule.)');
    const status = holdInInbox ? 'inbox' : 'active';

    const aFactorInit = round4(initialAFactor(this.settings, { total_pages, total_seconds }));
    const fmLines = [
      '---',
      'type: source',
      `source_type: ${sourceType}`,
      `status: ${status}`,
      `priority: ${pNum}`,
      `next_review: ${nextReview}`,
      `interval: ${interval}`,
      `a_factor: ${aFactorInit}`,
      'review_count: 0',
      'last_reviewed:',
    ];
    if (read_point !== null)         fmLines.push(`read_point: ${read_point}`);
    if (total_pages !== null)        fmLines.push(`total_pages: ${total_pages}`);
    if (sioyek_path)                 fmLines.push(`sioyek_path: ${JSON.stringify(sioyek_path)}`);
    if (source_url)                  fmLines.push(`source_url: ${JSON.stringify(source_url)}`);
    if (video_url)                   fmLines.push(`video_url: ${JSON.stringify(video_url)}`);
    if (video_id)                    fmLines.push(`video_id: ${JSON.stringify(video_id)}`);
    if (video_path)                  fmLines.push(`video_path: ${JSON.stringify(video_path)}`);
    if (read_point_seconds !== null) fmLines.push(`read_point_seconds: ${read_point_seconds}`);
    if (total_seconds !== null)      fmLines.push(`total_seconds: ${total_seconds}`);
    if (author)                      fmLines.push(`author: ${JSON.stringify(author)}`);
    fmLines.push(`date_added: ${today}`);
    fmLines.push('tags:');
    fmLines.push('  - incremental-reading');
    fmLines.push('  - ir/source');
    fmLines.push('---');

    let body = `\n# ${title}\n\n`;
    if (sourceType === 'book' || sourceType === 'pdf') {
      body += `> [!tip] Open in viewer\n> Run **IR Open PDF** (Obsidian) or **IR Open Sioyek** (external).\n\n`;
    } else if (sourceType === 'youtube') {
      body += `<iframe width="640" height="360" src="https://www.youtube.com/embed/${video_id}?start=${read_point_seconds}" frameborder="0" allowfullscreen></iframe>\n\n`;
    } else if (sourceType === 'video') {
      body += `![[${video_path}]]\n\n`;
    }
    body += `## Reading Notes\n\n\n## Extracts\n\n`;

    const safeTitle = slugifyForFolder(title);
    if (!safeTitle) { new Notice('Source title does not contain a valid filename.'); return; }
    const sourcesFolder = this.sourcesFolder();
    await ensureFolder(this.app, sourcesFolder);
    const path = `${sourcesFolder}/${safeTitle}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Already exists: ${path}`); return;
    }
    const f = await this.app.vault.create(path, fmLines.join('\n') + body);
    await this.app.workspace.getLeaf(false).openFile(f);
    new Notice(`Created ${title} (${status}) a=${aFactorInit}`);
  }

  async importClipping() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') {
      new Notice('Open a clipper note first.'); return;
    }
    const existing = getFm(this.app, active);
    if (existing?.type === 'source') { new Notice('Already an incremental reading source.'); return; }

    const priStr = await askText(this.app, 'Priority (1-100, 1=highest)', '50');
    if (priStr === null) return;
    const p = parseInt(priStr, 10);
    if (isNaN(p) || p < 1 || p > 100) { new Notice('Invalid priority.'); return; }

    const today = todayDateString(this.settings);
    const interval = priorityToInterval(p);
    const nextReview = futureDateString(interval, this.settings);
    const hold = await confirmDialog(this.app, 'Hold in inbox? (Otherwise active.)');
    const initialStatus = hold ? 'inbox' : 'active';

    const aFactorInit = round4(initialAFactor(this.settings, {
      total_pages: Number(existing?.total_pages) || null,
      total_seconds: Number(existing?.total_seconds) || null,
    }));

    await this.app.fileManager.processFrontMatter(active, (fm) => {
      fm.type = 'source';
      fm.source_type = 'article';
      fm.status = initialStatus;
      fm.priority = p;
      fm.next_review = nextReview;
      fm.interval = interval;
      fm.a_factor = aFactorInit;
      fm.review_count = 0;
      fm.last_reviewed = null;
      fm.read_point = null;
      fm.total_pages = null;
      fm.sioyek_path = null;
      for (const k of ['ease', 'stability', 'difficulty', 'last_grade', 'last_retrievability']) {
        if (fm[k] !== undefined) delete fm[k];
      }
      if (!fm.source_url && fm.source) fm.source_url = fm.source;
      fm.date_added = today;
      if (typeof fm.tags === 'string') fm.tags = fm.tags.split(/[\s,]+/).filter(Boolean);
      if (!Array.isArray(fm.tags)) fm.tags = [];
      if (!fm.tags.includes('incremental-reading')) fm.tags.push('incremental-reading');
      if (!fm.tags.includes('ir/source')) fm.tags.push('ir/source');
    });

    const sourcesFolder = this.sourcesFolder();
    await ensureFolder(this.app, sourcesFolder);
    const safeName = (slugifyForFolder(active.basename) || 'Untitled') + '.md';
    const newPath = `${sourcesFolder}/${safeName}`;
    let renameNote = '';
    if (active.path === newPath) {
      // already in sources
    } else if (this.app.vault.getAbstractFileByPath(newPath)) {
      renameNote = ' · NOT moved (target exists)';
    } else {
      await this.app.fileManager.renameFile(active, newPath);
    }
    new Notice(`Imported (${initialStatus}) · p${p} · review +${interval}d${renameNote}`);
  }

  // ---- Navigation --------------------------------------------------------

  async openDashboard() {
    const f = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!f) { new Notice(`Dashboard not found at ${DASHBOARD_PATH}`); return; }
    await this.app.workspace.getLeaf(false).openFile(f);
  }

  async openParent() {
    const active = this.app.workspace.getActiveFile();
    if (!active) { new Notice('No active file.'); return; }
    const fm = getFm(this.app, active);
    if (!fm) { new Notice('No frontmatter.'); return; }
    if (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card') {
      new Notice('Not an incremental reading element.'); return;
    }
    const parentName = (fm.type === 'card' || fm.type === 'extract')
      ? linkTarget(fm.source) : linkTarget(fm.parent);
    if (!parentName) { new Notice('No parent link.'); return; }
    const parent = this.app.metadataCache.getFirstLinkpathDest(parentName, active.path);
    if (!parent) { new Notice(`Parent "${parentName}" not found.`); return; }
    await this.app.workspace.getLeaf(false).openFile(parent);
    new Notice(`↑ ${parent.basename}`);
  }

  async openPdf() {
    const r = await resolveSourceFromActive(this.app, this.settings);
    if (!r) return;
    const fm = r.fm;
    if (!fm.sioyek_path) { new Notice('No sioyek_path set.'); return; }
    const abs = String(fm.sioyek_path);
    const ext = (abs.split('.').pop() || '').toLowerCase();
    if (ext === 'epub') { new Notice('Epub not supported by Obsidian viewer.'); return; }
    if (ext !== 'pdf') { new Notice(`Unsupported extension .${ext}`); return; }
    const vaultBase = vaultAbsPath(this.app, '');
    if (!abs.startsWith(vaultBase)) {
      new Notice('PDF outside vault. Use Open Sioyek.'); return;
    }
    const rel = abs.slice(vaultBase.length);
    if (!this.app.vault.getAbstractFileByPath(rel)) { new Notice(`PDF not found at ${rel}`); return; }
    const ps = Number(fm.page_start) || null, pe = Number(fm.page_end) || null, rp = Number(fm.read_point) || null;
    let page = (rp && ps && pe) ? Math.max(ps, Math.min(rp, pe)) : (rp || ps || 1);
    await this.app.workspace.openLinkText(`${rel}#page=${page}`, '', false);
    new Notice(`📄 Opened at page ${page}`);
  }

  async openSioyek() {
    const r = await resolveSourceFromActive(this.app, this.settings);
    if (!r) return;
    const fm = r.fm;
    if (!fm.sioyek_path) { new Notice('No sioyek_path set.'); return; }
    const ps = Number(fm.page_start) || null, pe = Number(fm.page_end) || null, rp = Number(fm.read_point) || null;
    let page = (rp && ps && pe) ? Math.max(ps, Math.min(rp, pe)) : (rp || ps || 1);
    const { execFile } = require('child_process');
    execFile(this.settings.paths.sioyek, ['--page', String(page), fm.sioyek_path], (err) => {
      if (err) new Notice('Failed to open Sioyek: ' + err.message);
      else new Notice(`Opened in Sioyek at page ${page}`);
    });
  }

  async toggleReadPoint() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Open a markdown source.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not an incremental reading source.'); return; }
    if (fm.total_pages || fm.sioyek_path) {
      new Notice('PDF/epub source — use IR Open Sioyek/PDF.'); return;
    }
    const editor = getEditorForFile(this.app, active);
    const cursor = editor?.getCursor?.();
    if (!editor || !cursor) { new Notice('No editor cursor.'); return; }
    const content = await this.app.vault.read(active);
    READ_POINT_RE.lastIndex = 0;
    const hasMarker = READ_POINT_RE.test(content);

    let action;
    if (hasMarker) {
      action = await pickFromList(
        this.app,
        [`Move 📍 to line ${cursor.line + 1}`, 'Clear 📍 marker'],
        ['move', 'clear'],
        '📍 already set'
      );
    } else {
      action = await pickFromList(
        this.app, [`Set 📍 at line ${cursor.line + 1}`], ['set'], '📍 marker'
      );
    }
    if (!action) return;
    await this.app.vault.process(active, (text) => {
      let stripped = text;
      const ms = [...text.matchAll(READ_POINT_RE)];
      for (const m of ms.reverse()) {
        stripped = stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length);
      }
      if (action === 'clear') return stripped;
      const fmEnd = frontmatterEndOffset(stripped);
      const lines = stripped.split('\n');
      let insertAt = 0;
      for (let i = 0; i < cursor.line; i++) insertAt += lines[i].length + 1;
      if (insertAt < fmEnd) insertAt = fmEnd;
      return stripped.slice(0, insertAt) + READ_POINT_MARKER + stripped.slice(insertAt);
    });
    await this.app.fileManager.processFrontMatter(active, (next) => {
      if (action === 'clear') delete next.read_point_line;
      else next.read_point_line = cursor.line + 1;
    });
    new Notice(action === 'clear' ? '📍 cleared.' : `📍 ${action} at line ${cursor.line + 1}`);
  }

  async jumpToReadPoint() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Not a markdown source.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not an incremental reading source.'); return; }
    if (fm.total_pages || fm.sioyek_path) {
      new Notice('PDF/epub — use IR Open Sioyek.'); return;
    }
    const content = await this.app.vault.read(active);
    const m = content.match(/(?:📍\s*)?<!--ir-readpoint-->/);
    if (!m) { new Notice('No 📍 read-point.'); return; }
    const before = content.slice(0, m.index);
    const line = (before.match(/\n/g) || []).length;
    const ch = m.index - (before.lastIndexOf('\n') + 1);
    let leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view?.file?.path === active.path);
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(active);
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const editor = leaf.view?.editor;
    if (editor) {
      editor.setCursor({ line, ch });
      editor.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
      new Notice(`Jumped to 📍 (line ${line + 1})`);
    } else new Notice('Editor not available.');
  }

  // ---- Stats -------------------------------------------------------------

  async stats() {
    const today = todayDate();
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    let nSrc = 0, nExt = 0, nCard = 0;
    let nDone = 0, nDismissed = 0, nInbox = 0;
    let overdue = 0, dueToday = 0, future = 0;
    let todayRev = 0, weekRev = 0;
    let todaySrc = 0, todayExt = 0;
    for (const f of getAllIRFiles(this.app, this.settings)) {
      const fm = getFm(this.app, f);
      if (!fm) continue;
      if (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card') continue;
      if (fm.type === 'card') { nCard++; continue; }
      if (fm.status === 'done') { nDone++; continue; }
      if (fm.status === 'dismissed') { nDismissed++; continue; }
      if (fm.status === 'container') continue;
      if (fm.status === 'inbox') { nInbox++; continue; }
      if (fm.type === 'source') nSrc++;
      else if (fm.type === 'extract') nExt++;
      const nr = parseDateValue(fm.next_review, this.settings);
      if (nr) {
        const diff = daysBetween(today, nr);
        if (diff > 0) overdue++;
        else if (diff === 0) dueToday++;
        else future++;
      } else dueToday++;
      const lr = parseDateValue(fm.last_reviewed, this.settings);
      if (lr) {
        if (lr.getTime() === today.getTime()) {
          todayRev++;
          if (fm.type === 'source') todaySrc++;
          else if (fm.type === 'extract') todayExt++;
        }
        if (lr >= weekAgo) weekRev++;
      }
    }

    let lifetime = 0;
    const logFile = this.app.vault.getAbstractFileByPath(this.reviewLogPath());
    if (logFile) {
      const log = await this.app.vault.read(logFile);
      const rows = log.split('\n').filter(line => {
        const firstCell = line.match(/^\|\s*([^|]+?)\s*\|/)?.[1];
        return !!parseDateValue(firstCell, this.settings);
      });
      lifetime = rows.length;
    }

    const lines = [
      '**Incremental Reading Toolkit stats**', '',
      `📊 Reading topics: ${nSrc + nExt} active (${nSrc}s / ${nExt}x) · ${nCard} card files`,
      `📅 Queue: 🔴 ${overdue} overdue · 🟡 ${dueToday} due today · 🟢 ${future} scheduled`,
      `📦 Inbox: ${nInbox} · ✅ Done: ${nDone} · 🚫 Dismissed: ${nDismissed}`, '',
      `🔥 Today: ${todayRev} topics reviewed (${todaySrc}s / ${todayExt}x)`,
      `📆 Last 7 days: ${weekRev} reviewed`,
      `🗂️ Lifetime reading log: ${lifetime} reviews`,
      'Card scheduling and statistics are in Spaced Repetition.',
    ];
    new Notice(lines.join('\n'), 12000);
    this._dbg(lines.join('\n'));
  }

  // ---- Splits ------------------------------------------------------------

  async splitArticle() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Open a source note.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not a source.'); return; }
    if (fm.source_type !== 'article') { new Notice('Articles only — books use Split Book.'); return; }
    if (fm.status === 'container') { new Notice('Already split.'); return; }

    const content = await this.app.vault.read(active);
    const fmEnd = content.indexOf('\n---', 3);
    const body = fmEnd !== -1 ? content.slice(fmEnd + 4) : content;
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(m => ({ title: m[1].trim(), index: m.index }));
    if (headings.length === 0) { new Notice('No H2 headings found.'); return; }

    const confirmed = await askLong(this.app,
      'Headings to split on (delete lines to skip)',
      headings.map(h => h.title).join('\n'));
    if (!confirmed || confirmed.trim() === '') return;
    const titles = new Set(confirmed.split('\n').map(s => s.trim()).filter(Boolean));
    const selected = headings.filter(h => titles.has(h.title));
    if (selected.length === 0) return;

    const today = todayDateString(this.settings);
    const parentTitle = active.basename;
    const priority = fm.priority ?? 50;
    const baseInterval = priorityToInterval(priority);
    const folder = active.parent.path;
    const links = [];

    for (let i = 0; i < selected.length; i++) {
      const h = selected[i];
      const next = headings[headings.indexOf(h) + 1];
      const sectionBody = body.slice(h.index, next ? next.index : body.length).trimEnd();
      const interval = baseInterval + i;
      const nextReview = futureDateString(interval, this.settings);
      const noteTitle = slugifyForFolder(`${parentTitle} - ${h.title}`) || `${parentTitle} - Section ${i + 1}`;
      const noteContent = `---
type: source
source_type: article
status: active
parent: ${JSON.stringify(`[[${parentTitle}]]`)}
priority: ${priority}
next_review: ${nextReview}
interval: ${interval}
a_factor: 2.0
review_count: 0
last_reviewed:
date_added: ${today}
tags:
  - incremental-reading
  - ir/source
  - ir/sub-topic
---

${sectionBody}
`;
      const p = `${folder}/${noteTitle}.md`;
      if (!this.app.vault.getAbstractFileByPath(p)) {
        await this.app.vault.create(p, noteContent);
      }
      links.push(`- [[${noteTitle}]]`);
    }

    const subSection = `\n## Sub-topics\n\n${links.join('\n')}\n`;
    const bodyWithoutOld = content.replace(/\n## Sub-topics[\s\S]*?(?=\n## |$)/, '');
    await this.app.vault.process(active, () => bodyWithoutOld + subSection);
    await this.app.fileManager.processFrontMatter(active, (fmw) => { fmw.status = 'container'; });
    new Notice(`Split into ${selected.length} sub-topic${selected.length === 1 ? '' : 's'}.`);
  }

  async splitBook() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Open a book source note.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not a source.'); return; }
    if (fm.status === 'container') { new Notice('Already a container.'); return; }
    if (fm.source_type !== 'book' && fm.source_type !== 'pdf') {
      const cont = await confirmDialog(this.app, "Not a book/PDF — proceed anyway?");
      if (!cont) return;
    }
    const toc = await askLong(this.app,
      "Paste chapter list (one per line): 'START-END: Title' or 'START: Title'",
      '');
    if (!toc) return;
    const lines = toc.split('\n').map(l => l.trim()).filter(Boolean);
    const chapters = [];
    for (const line of lines) {
      const m = line.match(/^(\d+)\s*(?:[-–—]\s*(\d+))?\s*[:：]\s*(.+)$/);
      if (!m) { new Notice(`Can't parse: "${line}"`); return; }
      chapters.push({ start: parseInt(m[1], 10), end: m[2] ? parseInt(m[2], 10) : null, title: m[3].trim() });
    }
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].end == null) {
        chapters[i].end = (i + 1 < chapters.length)
          ? chapters[i + 1].start - 1
          : (fm.total_pages ?? chapters[i].start);
      }
    }

    const parentTitle = active.basename;
    const priority = fm.priority ?? 50;
    const baseInterval = priorityToInterval(priority);
    const sourceType = fm.source_type ?? 'book';
    const sioyekPath = fm.sioyek_path ?? null;
    const totalPages = fm.total_pages ?? null;
    const dateAdded = fm.date_added ?? todayDateString(this.settings);
    const folder = this.sourcesFolder();
    await ensureFolder(this.app, folder);
    let created = 0;
    const skipped = [];

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const num = String(i + 1).padStart(2, '0');
      const safeTitle = slugifyForFolder(ch.title) || `Chapter ${i + 1}`;
      const name = slugifyForFolder(`${parentTitle} - Ch${num} ${safeTitle}`);
      const path = `${folder}/${name}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) { skipped.push(name); continue; }

      const chInterval = baseInterval + i;
      const chNext = futureDateString(chInterval, this.settings);
      const chPages = (ch.end != null && ch.start != null) ? Math.max(1, ch.end - ch.start + 1) : null;
      const chAFactor = round4(initialAFactor(this.settings, { total_pages: chPages }));

      const content = `---
type: source
source_type: ${sourceType}
status: active
priority: ${priority}
parent: ${JSON.stringify(`[[${parentTitle}]]`)}
chapter_num: ${i + 1}
next_review: ${chNext}
interval: ${chInterval}
a_factor: ${chAFactor}
review_count: 0
last_reviewed:
read_point: ${ch.start}
page_start: ${ch.start}
page_end: ${ch.end}
total_pages: ${totalPages}
sioyek_path: ${sioyekPath ? JSON.stringify(sioyekPath) : ''}
date_added: ${dateAdded}
tags:
  - incremental-reading
  - ir/source
  - ir/chapter
---

# ${ch.title}

> [!tip] Parent
> [[${parentTitle}]] — pages ${ch.start}–${ch.end} (${ch.end - ch.start + 1}p)

## Notes


## Extracts

`;
      await this.app.vault.create(path, content);
      created++;
    }

    await this.app.fileManager.processFrontMatter(active, (fmw) => {
      fmw.status = 'container';
      fmw.next_review = null;
    });
    await this.app.vault.process(active, (cur) => {
      if (cur.includes('## Chapters')) return cur;
      const list = chapters.map((ch, i) => {
        const num = String(i + 1).padStart(2, '0');
        const safeTitle = slugifyForFolder(ch.title) || `Chapter ${i + 1}`;
        const name = slugifyForFolder(`${parentTitle} - Ch${num} ${safeTitle}`);
        return `- [[${name}]] (p.${ch.start}–${ch.end})`;
      }).join('\n');
      return cur.trimEnd() + `\n\n## Chapters\n\n${list}\n`;
    });
    const skipMsg = skipped.length ? ` | Skipped ${skipped.length} (already exist)` : '';
    new Notice(`Split: ${created} chapter(s).${skipMsg}`);
  }
}

function formatSeconds(s) {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// Helper used outside the class (newSource)
function parseTimeInput(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map(p => p.trim());
  if (!parts.every(p => /^\d+$/.test(p))) return null;
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  return null;
}

module.exports = IncrementalReadingPlugin;
