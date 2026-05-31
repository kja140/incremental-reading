'use strict';

const {
  Plugin, Notice, Modal, FuzzySuggestModal, SuggestModal, TFile, parseYaml,
  MarkdownRenderer, Component, PluginSettingTab, Setting, ItemView, WorkspaceLeaf,
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

// Effective parent NAME: explicit `parent` link wins, else `source` (legacy fallback).
function effectiveParent(fm) {
  if (!fm) return null;
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
  for (const p of pages) byName.set(p.basename.toLowerCase(), p);
  const childrenOf = new Map();
  const roots = [];
  for (const p of pages) {
    const parentName = effectiveParent(p.fm);
    const key = parentName ? parentName.toLowerCase() : null;
    if (key && byName.has(key)) {
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(p);
    } else {
      roots.push(p);
    }
  }
  const cmp = siblingComparator;
  roots.sort(cmp);
  for (const arr of childrenOf.values()) arr.sort(cmp);
  return { byName, childrenOf, roots };
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

const READ_POINT_MARKER = '📍<!--ir-readpoint-->';
const READ_POINT_RE = /(?:📍\s*)?<!--ir-readpoint-->/g;
const BODY_MARKER = '<!--ir-card-body-->';
// ==highlight== cloze marker. Inner allows single '=' (LaTeX like ==E = mc^2==)
// but not '==', so the closing delimiter is never swallowed. Build per-use with
// `new RegExp(HL_CLOZE_SRC, 'g')` — shared lastIndex across call sites would corrupt matchAll/replace.
const HL_CLOZE_SRC = '==((?:[^=]|=(?!=))+)==';

// FSRS-6: weights live in settings (DEFAULT_SETTINGS.fsrs.weights). Helpers
// below take an `fsrsCtx` so per-call weight edits via the settings tab take
// effect on the next review.
// Reference implementation: open-spaced-repetition/ts-fsrs v6.
const FSRS_DEFAULT_RETENTION = 0.9;

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
  fsrs: {
    // FSRS-6 canonical defaults (21 params, w0..w20). w19 = same-day stability
    // exponent, w20 = learnable decay (drives the power-law forgetting curve).
    weights: [
      0.2172, 1.1771, 3.2602, 16.1507,
      7.0114, 0.57,
      2.0966, 0.0069,
      1.5261, 0.112, 1.0178,
      1.849, 0.1133, 0.3127, 2.2934,
      0.2191, 3.0004, 0.7536, 0.3332,
      0.1437, 0.2,
    ],
    decay: 0.2,  // fallback only; live value is w[20] when 21 weights are present
    request_retention: 0.9,
    fuzz: false,
    short_term_enabled: true,
  },
  queue: {
    auto_postpone_threshold: 30,
    auto_postpone_skip_top: 10,
    sidebar_enabled: true,
    default_tag_filter: '',
    sort_key: 'urgency',
  },
  inline_cards: {
    enabled: true,
    qa_regex: '^Q::\\s*(.+?)\\s*::A::\\s*(.+)$',
    cloze_regex: '\\{\\{c(\\d+)::([^}]+?)(?:::([^}]+?))?\\}\\}',
    default_deck_tag: 'inline',
  },
  paths: {
    sources: 'Sources/Incremental Reading/Sources',
    extracts: 'Sources/Incremental Reading/Extracts',
    cards: 'Sources/Incremental Reading/Cards',
    review_log: 'Sources/Incremental Reading/Review Log.md',
    sioyek: '/Applications/sioyek.app/Contents/MacOS/sioyek',
    daily_note: 'Calendar',
  },
  misc: {
    debug: false,
  },
  tree: {
    expanded: [],
    child_warn_threshold: 100,
  },
};

// Build an FSRS context from current settings. Pass to every fsrs* helper.
function fsrsCtx(settings) {
  const w = settings?.fsrs?.weights || DEFAULT_SETTINGS.fsrs.weights;
  // FSRS-6: decay is learnable as w[20]. Fall back to the fixed `decay` setting for
  // legacy 19-weight (FSRS-5) params so existing review history keeps its schedule.
  const decay = (w.length > 20 && Number.isFinite(w[20]) && w[20] > 0)
    ? w[20]
    : (settings?.fsrs?.decay ?? DEFAULT_SETTINGS.fsrs.decay);
  const factor = Math.pow(0.9, -1 / decay) - 1;  // FSRS-6 forgetting-curve factor
  const r = settings?.fsrs?.request_retention ?? DEFAULT_SETTINGS.fsrs.request_retention;
  const fuzz = settings?.fsrs?.fuzz ?? DEFAULT_SETTINGS.fsrs.fuzz;
  return { w, decay, factor, r, fuzz };
}

// ============================================================================
//  Date helpers (vault uses DD-MM-YYYY)
// ============================================================================

function parseDMY(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
}

function formatDMY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function todayDMY() { return formatDMY(todayDate()); }

function todayDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function futureDMY(days) {
  const d = todayDate();
  d.setDate(d.getDate() + days);
  return formatDMY(d);
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

function urgency(fm, today) {
  const pri = fm.priority ? (101 - fm.priority) * 10 : 0;
  const nr = parseDMY(fm.next_review);
  if (!nr) return pri;
  const diff = daysBetween(today, nr);
  let u = pri + diff * 2;
  if (diff >= 0) u += 5000;
  return u;
}

function isDue(fm, today) {
  if (!fm.next_review) return true;
  const nr = parseDMY(fm.next_review);
  if (!nr) return true;
  return nr <= today;
}

function isPastDue(fm, today) {
  if (!fm.next_review) return false;
  const nr = parseDMY(fm.next_review);
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

const A_FACTOR_BUMP_EXTRACT = 1.05;  // retained — fired on extract creation only.

function progressAwareAFactor(fm, settings) {
  const s = settings.scheduling;
  let remaining = null;
  if (Number(fm.total_pages) > 0) {
    const read = Math.max(0, Math.min(Number(fm.read_point) || 0, Number(fm.total_pages)));
    remaining = Math.max(1, Number(fm.total_pages) - read);
  } else if (Number(fm.total_seconds) > 0) {
    const read = Math.max(0, Math.min(Number(fm.read_point_seconds) || 0, Number(fm.total_seconds)));
    remaining = Math.max(1, (Number(fm.total_seconds) - read) / 60);
  }
  if (remaining == null) return null;
  const af = s.initial_af_base - s.initial_af_slope * Math.log2(remaining / s.initial_af_units_divisor);
  return Math.max(s.a_factor_min, Math.min(s.a_factor_max, af));
}

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
//  FSRS-6 core
// ============================================================================

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const round4 = (x) => Math.round(x * 10000) / 10000;

function fsrsRetrievability(ctx, elapsedDays, stability) {
  if (!stability || stability <= 0) return 1.0;
  const { factor, decay } = ctx;
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + factor * t / stability, -decay);
}

function fsrsInterval(ctx, stability, r) {
  const { factor, decay } = ctx;
  const target = r ?? ctx.r;
  let days = stability / factor * (Math.pow(target, -1 / decay) - 1);
  if (ctx.fuzz) {
    const jitter = (Math.random() * 0.1 - 0.05);  // ±5%
    days = days * (1 + jitter);
  }
  return Math.max(1, Math.round(days));
}

function fsrsSeedDifficulty(ctx, grade) {
  const { w } = ctx;
  // D0(G) = w4 - exp(w5 * (G - 1)) + 1   (FSRS-6)
  return clamp(w[4] - Math.exp(w[5] * (grade - 1)) + 1, 1, 10);
}

function fsrsUpdateDifficulty(ctx, d, grade) {
  const { w } = ctx;
  // Linear damping then mean reversion toward D0(Easy).
  const deltaD = -w[6] * (grade - 3);
  const damped = d + deltaD * (10 - d) / 9;
  const target = fsrsSeedDifficulty(ctx, 4);
  const dNew = w[7] * target + (1 - w[7]) * damped;
  return clamp(dNew, 1, 10);
}

function fsrsUpdateStabilityRecall(ctx, d, s, r, grade) {
  const { w } = ctx;
  const hard = grade === 2 ? w[15] : 1;
  const easy = grade === 4 ? w[16] : 1;
  const factor = Math.exp(w[8])
              * (11 - d)
              * Math.pow(s, -w[9])
              * (Math.exp((1 - r) * w[10]) - 1)
              * hard
              * easy;
  return Math.max(0.01, s * (1 + factor));
}

function fsrsUpdateStabilityLapse(ctx, d, s, r) {
  const { w } = ctx;
  const sLapse = w[11]
              * Math.pow(d, -w[12])
              * (Math.pow(s + 1, w[13]) - 1)
              * Math.exp((1 - r) * w[14]);
  return Math.max(0.01, Math.min(sLapse, s));
}

function fsrsShortTermStability(ctx, s, grade) {
  const { w } = ctx;
  // FSRS-6 same-day stability: exponent on S is the learnable w[19] (was a fixed
  // 0.5 in FSRS-5). Legacy 19-weight params fall back to 0.5.
  const sExp = (w.length > 19 && Number.isFinite(w[19])) ? w[19] : 0.5;
  const sInc = Math.exp(w[17] * (grade - 3 + w[18])) * Math.pow(s, -sExp);
  return clamp(s * sInc, 0.01, 36500);
}

// ============================================================================
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
//  Each match yields a stable id so FSRS state in inline_cards[] survives
//  edits elsewhere in the file.
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

async function updateInlineCardState(app, filePath, cardId, mutator) {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const idx = (fm.inline_cards || []).findIndex(c => c.id === cardId);
    if (idx < 0) return;
    fm.inline_cards[idx] = mutator(fm.inline_cards[idx]);
  });
}

// Build the synthetic `type:'card'` frontmatter the review/queue/dashboard code
// expects from an inline card sub-object `c` of parent note `parentFm` at `parentPath`.
function inlineCardFm(c, parentFm, parentPath) {
  return {
    ...c,
    type: 'card',
    status: c.status || 'active',
    priority: c.priority ?? parentFm?.priority ?? 50,
    inline_parent: parentPath,
  };
}

// ============================================================================
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

    const hideOneBtn = buttonRow.createEl('button', { text: 'Generate: Hide-one (N cards)', cls: 'mod-cta' });
    hideOneBtn.title = 'One card per rect; each card hides exactly that rect, reveals others.';
    hideOneBtn.addEventListener('click', () => this._commit('hide-one'));

    const showOneBtn = buttonRow.createEl('button', { text: 'Generate: Show-one (N cards)' });
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
//  FlashcardModal — single centered window for review.
//
//  Stages: 'question' → user clicks Show Answer → 'answer' → user picks grade.
//  Resolves with grade (1-4) or null on cancel/close.
//
//  Renders markdown for question and answer via MarkdownRenderer so cloze
//  marks, embedded images, callouts, math etc. all paint correctly.
//  For occlusion cards the question/answer markdown contain the
//  ir-occlusion code block — the renderer (registered in onload) handles
//  cover overlays. Pass `hideQuestionAnswerLabels: true` to skip the
//  "QUESTION:" / "ANSWER:" headers (used for occlusion since the image is
//  the question).
// ------------------------------------------------------------------
class FlashcardModal extends Modal {
  constructor(app, opts, resolve) {
    super(app);
    this.opts = opts;          // { title, sourcePath, questionMd, answerMd, hideLabels }
    this.resolve = resolve;
    this._resolved = false;
    this._renderComponent = new Component();
  }
  onOpen() {
    const { contentEl, modalEl, titleEl } = this;
    titleEl.setText(this.opts.title || 'Review');

    // Make the modal nice and roomy
    modalEl.addClass('ir-fc-modal-el');

    contentEl.empty();
    contentEl.addClass('ir-fc-modal');

    if (!this.opts.hideLabels) {
      contentEl.createEl('div', { cls: 'ir-fc-label', text: 'Question' });
    }

    const qBox = contentEl.createDiv({ cls: 'ir-fc-question ir-fc-box markdown-rendered' });
    this._renderMd(qBox, this.opts.questionMd || '');

    this.aLabel = null;
    this.aBox = contentEl.createDiv({ cls: 'ir-fc-answer ir-fc-box ir-fc-answer-box markdown-rendered ir-hidden' });

    const btnRow = contentEl.createDiv({ cls: 'ir-fc-btn-row' });
    this.btnRow = btnRow;

    if (this.opts.directGrade) {
      // For occlusion: in-card Show Answer drives reveal; modal jumps straight
      // to grading. We still call _reveal() to set up the grade buttons but
      // pass an empty answer so it doesn't paint a duplicate block.
      this.opts.answerMd = '';
      this._reveal();
    } else {
      this.showBtn = btnRow.createEl('button', { text: 'Show Answer (Space)', cls: 'mod-cta ir-fc-show-btn' });
      this.showBtn.addEventListener('click', () => this._reveal());
      window.setTimeout(() => this.showBtn.focus(), 30);
    }

    this._keyHandler = (e) => {
      if (this._resolved) return;
      if (this.stage === 'question') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this._reveal();
        }
      } else if (this.stage === 'answer') {
        if (e.key >= '1' && e.key <= '4') {
          e.preventDefault();
          this._grade(parseInt(e.key, 10));
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._cancel();
      }
    };
    contentEl.addEventListener('keydown', this._keyHandler);
    this.stage = 'question';
  }
  _renderMd(target, md) {
    target.empty();
    if (MarkdownRenderer?.render) {
      MarkdownRenderer.render(this.app, md, target, this.opts.sourcePath || '', this._renderComponent);
    } else {
      target.setText(md);
    }
  }
  _reveal() {
    if (this.stage !== 'question') return;
    this.stage = 'answer';
    const hasAnswer = !!(this.opts.answerMd && this.opts.answerMd.trim());
    if (hasAnswer) {
      if (!this.opts.hideLabels) {
        this.aLabel = this.contentEl.createEl('div', { cls: 'ir-fc-label ir-fc-label-answer', text: 'Answer' });
        this.contentEl.insertBefore(this.aLabel, this.aBox);
      }
      this.aBox.removeClass('ir-hidden');
      this._renderMd(this.aBox, this.opts.answerMd);
    }
    this.btnRow.empty();
    const grades = [
      { n: 1, label: 'Again', sub: '1', cls: 'ir-fc-grade-1' },
      { n: 2, label: 'Hard',  sub: '2', cls: 'ir-fc-grade-2' },
      { n: 3, label: 'Good',  sub: '3', cls: 'ir-fc-grade-3 mod-cta' },
      { n: 4, label: 'Easy',  sub: '4', cls: 'ir-fc-grade-4' },
    ];
    for (const g of grades) {
      const b = this.btnRow.createEl('button', { cls: `${g.cls} ir-fc-grade-btn` });
      b.createDiv({ cls: 'ir-fc-grade-label', text: g.label });
      b.createDiv({ cls: 'ir-fc-grade-key', text: `(${g.sub})` });
      b.addEventListener('click', () => this._grade(g.n));
    }
    window.setTimeout(() => this.btnRow.querySelector('.mod-cta')?.focus(), 30);
  }
  _grade(n) {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(n);
  }
  _cancel() {
    if (this._resolved) return;
    this._resolved = true;
    this.close();
    this.resolve(null);
  }
  onClose() {
    if (this._keyHandler) this.contentEl.removeEventListener('keydown', this._keyHandler);
    this._renderComponent.unload();
    this.contentEl.empty();
    if (!this._resolved) {
      this._resolved = true;
      this.resolve(null);
    }
  }
}

function reviewCard(app, opts) {
  return new Promise((res) => new FlashcardModal(app, opts, res).open());
}

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
  const base = adapter.basePath || adapter.getBasePath?.();
  if (!base) return null;
  const sep = base.endsWith('/') ? '' : '/';
  return base + sep + relPath;
}

function getFm(app, file) {
  return file ? app.metadataCache.getFileCache(file)?.frontmatter : null;
}

function getAllIRFiles(app) {
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(ROOT + '/'));
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
async function resolveSourceFromActive(app) {
  const active = app.workspace.getActiveFile();
  if (!active) { new Notice('No active file.'); return null; }

  if (active.extension === 'md') {
    const fm = getFm(app, active);
    if (fm?.type === 'source') return { tfile: active, fm };
    new Notice('Active note is not an IR source.');
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
  for (const f of app.vault.getMarkdownFiles()) {
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
async function resolveSourceOrExtractFromActive(app) {
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
        || app.vault.getMarkdownFiles().find(f => f.basename === parentName);
      if (!parentTf) { new Notice(`Parent not found: ${parentName}`); return null; }
      const parentFm = getFm(app, parentTf);
      if (!parentFm || (parentFm.type !== 'source' && parentFm.type !== 'extract')) {
        new Notice('Card parent is not a source/extract.'); return null;
      }
      return { tfile: parentTf, fm: parentFm };
    }
    new Notice('Active note is not an IR source/extract/card.');
    return null;
  }

  if (active.extension === 'pdf') return await resolveSourceFromActive(app);
  new Notice('Active file must be an IR element or PDF.');
  return null;
}

// Resolve any IR element from active (source / extract / card). Falls back
// to source-resolution when active is a PDF.
async function resolveIRFromActive(app, { allowCard = true, allowPdfFallback = true } = {}) {
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
    return await resolveSourceFromActive(app);
  }
  new Notice('Active file must be an IR element (or linked PDF).');
  return null;
}

// BFS subtree walk via parent + source links.
function walkSubtree(app, rootBasename, rootPath, { includeCards = true } = {}) {
  const allPages = app.vault.getMarkdownFiles()
    .map(f => ({ tfile: f, fm: getFm(app, f) }))
    .filter(p => p.fm && (p.fm.type === 'source' || p.fm.type === 'extract' || (includeCards && p.fm.type === 'card')));
  const paths = new Set([rootPath]);
  const frontier = [rootBasename];
  const MAX = 6;
  for (let d = 0; d < MAX && frontier.length; d++) {
    const next = [];
    for (const name of frontier) {
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
  }

  getViewType() { return IR_QUEUE_VIEW_TYPE; }
  getDisplayText() { return 'IR Queue'; }
  getIcon() { return 'list-checks'; }

  async onOpen() {
    this._render();
    let modifyTimer = null;
    this.registerEvent(this.plugin.app.vault.on('modify', () => {
      if (modifyTimer) window.clearTimeout(modifyTimer);
      modifyTimer = window.setTimeout(() => this._render(), 250);
    }));
    this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => this._render()));
    this.refreshTimer = window.setInterval(() => this._render(), 30000);
  }

  async onClose() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }

  _render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('ir-queue-root');

    root.createDiv({ cls: 'ir-queue-header', text: 'IR Queue' });

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
    // Inline cards are now first-class in the session/queue, so track which ones are
    // already shown there to avoid double-listing them in the inline section below.
    const sessionInlineIds = new Set(session.filter(s => s.fm?.inline_parent).map(s => s.fm.id));
    const groups = { overdue: [], newItems: [], active: [] };
    for (const file of getAllIRFiles(this.plugin.app)) {
      if (sessionPaths.has(file.path)) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!isActiveIR(fm)) continue;
      if (this._filterMiss(cache, file)) continue;
      const row = { tfile: file, file, fm };
      if (fm.status === 'pending' || fm.status === 'inbox') groups.newItems.push(row);
      else if (!fm.next_review) groups.active.push(row);
      else if (isPastDue(fm, today)) groups.overdue.push(row);
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
      if (sortKey === 'due_date') return (a.fm.next_review || '').localeCompare(b.fm.next_review || '');
      return urgency(b.fm, today) - urgency(a.fm, today);
    };
    groups.overdue.sort(sortFn);
    groups.newItems.sort(sortFn);
    groups.active.sort(sortFn);

    // 5. Inline cards section — keep existing per-card scan, render under its own header.
    const inlineRows = [];
    if (this.plugin.settings.inline_cards.enabled) {
      for (const file of getAllIRFiles(this.plugin.app)) {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!isActiveIR(fm) || (fm.type !== 'source' && fm.type !== 'extract')) continue;
        if (this._filterMiss(cache, file)) continue;
        const cards = fm.inline_cards || [];
        for (const c of cards) {
          if (c.status === 'done' || c.status === 'dismissed') continue;
          if (sessionInlineIds.has(c.id)) continue;  // already shown in Today's Session
          const synthetic = {
            file,
            tfile: file,
            fm: inlineCardFm(c, fm, file.path),
          };
          if (!c.next_review) inlineRows.push(synthetic);
          else if (isPastDue(synthetic.fm, today)) inlineRows.push(synthetic);
          else if (isDue(synthetic.fm, today)) inlineRows.push(synthetic);
        }
      }
      inlineRows.sort(sortFn);
    }

    // 6. Render in dashboard-like order.
    this._renderSection(root, "Today's Session", sessionFiltered);
    this._renderSection(root, 'Overdue (not in session)', groups.overdue);
    this._renderSection(root, 'New', groups.newItems);
    this._renderSection(root, 'Active (no due)', groups.active);
    if (inlineRows.length) this._renderSection(root, 'Inline cards (due)', inlineRows);
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
    this.plugin.app.commands.executeCommandById('ir-toolkit:jump-to-read-point');
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

class IRToolkitSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'IR Toolkit Settings' });
    this._scheduling(containerEl);
    this._fsrs(containerEl);
    this._queue(containerEl);
    this._inlineCards(containerEl);
    this._paths(containerEl);
    this._misc(containerEl);
  }

  _scheduling(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    sec.createEl('h3', { text: 'Scheduling' });
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

  _fsrs(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    sec.createEl('h3', { text: 'FSRS' });
    const s = this.plugin.settings.fsrs;
    const save = () => this.plugin.saveSettings();

    new Setting(sec)
      .setName('Weights (19 values)')
      .setDesc('JSON array, FSRS-6 canonical order w0..w20 (21 params; w20 = decay).')
      .addTextArea(t => {
        t.setValue(JSON.stringify(s.weights));
        t.inputEl.rows = 4;
        t.inputEl.addClass('ir-fullwidth');
        t.onChange(v => {
          try {
            const arr = JSON.parse(v);
            if (Array.isArray(arr) && arr.length === 19 && arr.every(x => Number.isFinite(x))) {
              s.weights = arr;
              save();
            }
          } catch (_) { /* ignore until valid JSON */ }
        });
      });

    new Setting(sec).setName('Decay (w20)').setDesc('Personalized forgetting-curve decay. 0.1–0.8 typical.')
      .addText(t => t.setValue(String(s.decay)).onChange(v => { s.decay = Number(v) || 0.5; save(); }));

    new Setting(sec).setName('Request retention').setDesc('Target retention used to pick the next interval.')
      .addText(t => t.setValue(String(s.request_retention)).onChange(v => { s.request_retention = Number(v) || 0.9; save(); }));

    new Setting(sec).setName('Fuzz interval').setDesc('Randomize next interval ±5%.')
      .addToggle(t => t.setValue(s.fuzz).onChange(v => { s.fuzz = v; save(); }));

    new Setting(sec).setName('Same-day short-term path').setDesc('Use FSRS-6 short-term stability when re-reviewing within the same day.')
      .addToggle(t => t.setValue(s.short_term_enabled).onChange(v => { s.short_term_enabled = v; save(); }));
  }

  _queue(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    sec.createEl('h3', { text: 'Queue' });
    const s = this.plugin.settings.queue;
    const save = () => this.plugin.saveSettings();
    new Setting(sec).setName('Auto-postpone threshold')
      .addText(t => t.setValue(String(s.auto_postpone_threshold)).onChange(v => { s.auto_postpone_threshold = Number(v) || 30; save(); }));
    new Setting(sec).setName('Skip top N priorities')
      .addText(t => t.setValue(String(s.auto_postpone_skip_top)).onChange(v => { s.auto_postpone_skip_top = Number(v) || 10; save(); }));
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
    sec.createEl('h3', { text: 'Inline cards' });
    const s = this.plugin.settings.inline_cards;
    const save = () => this.plugin.saveSettings();
    new Setting(sec).setName('Enabled')
      .addToggle(t => t.setValue(s.enabled).onChange(v => { s.enabled = v; save(); }));
    new Setting(sec).setName('Q::A regex')
      .addText(t => t.setValue(s.qa_regex).onChange(v => { s.qa_regex = v; save(); }));
    new Setting(sec).setName('Cloze regex')
      .addText(t => t.setValue(s.cloze_regex).onChange(v => { s.cloze_regex = v; save(); }));
    new Setting(sec).setName('Default deck tag')
      .addText(t => t.setValue(s.default_deck_tag).onChange(v => { s.default_deck_tag = v; save(); }));
  }

  _paths(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    sec.createEl('h3', { text: 'Paths' });
    const s = this.plugin.settings.paths;
    const save = () => this.plugin.saveSettings();
    for (const key of ['sources', 'extracts', 'cards', 'review_log', 'sioyek', 'daily_note']) {
      new Setting(sec).setName(key)
        .addText(t => t.setValue(s[key]).onChange(v => { s[key] = v; save(); }));
    }
  }

  _misc(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    sec.createEl('h3', { text: 'Misc' });
    const s = this.plugin.settings.misc;
    const save = () => this.plugin.saveSettings();
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
  }

  getViewType() { return this.mode === 'sidebar' ? KNOWLEDGE_TREE_SIDEBAR_TYPE : KNOWLEDGE_TREE_VIEW_TYPE; }
  getDisplayText() { return 'Knowledge Tree'; }
  getIcon() { return 'folder-tree'; }

  async onOpen() {
    this._render();
    let t = null;
    this.registerEvent(this.plugin.app.metadataCache.on('changed', () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => this._renderBody(), 300);
    }));
  }
  async onClose() {}

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
    for (const p of this.index.byName.values()) {
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
    for (const p of this.index.byName.values()) {
      if ((this.index.childrenOf.get(p.basename.toLowerCase()) || []).length) keys.push(p.path);
    }
    this.plugin.settings.tree.expanded = keys;
    this.plugin.saveSettings();
  }

  async _openPage(page) {
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(page.tfile);
    if (page.fm.type === 'source' || page.fm.type === 'extract') {
      this.plugin.app.commands.executeCommandById('ir-toolkit:jump-to-read-point');
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

class IRToolkit extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      this.settings[key] = Object.assign({}, DEFAULT_SETTINGS[key], this.settings[key] || {});
    }
    await this.saveData(this.settings);
    this.addSettingTab(new IRToolkitSettingTab(this.app, this));
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
      const btn = btnRow.createEl('button', { text: 'Show Answer' });
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
    cmd('forget-card',        'Forget card (reset FSRS)',        () => this.forgetCard());

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
    cmd('open-ir-queue',  'Open IR queue sidebar',  () => this._activateQueueView());
    cmd('open-knowledge-tree',         'Open knowledge tree',           () => this._activateKnowledgeTree());
    cmd('open-knowledge-tree-sidebar', 'Open knowledge tree (sidebar)', () => this._activateKnowledgeTreeSidebar());
    cmd('new-category',                'New category',                  async () => { await this.createCategory(); this._refreshTreeViews(); });
    cmd('tree-reparent-active',        'Move active element under…',    async () => { await this.reparentActive(); this._refreshTreeViews(); });
    cmd('checkpoint',     'Add timeline checkpoint', () => this.addCheckpoint());
    cmd('seed-inline-cards', 'Seed inline cards from current file body', () => this.seedInlineCards());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Debug logging — silent unless the user enables it in settings. Keeps the
  // default console clean (Obsidian guideline: only errors by default).
  _dbg(...args) {
    if (this.settings?.misc?.debug) console.log('[IR Toolkit]', ...args);
  }

  // ---- Next / Random -----------------------------------------------------

  buildDuePool({ skipCurrent = true } = {}) {
    const today = todayDate();
    const active = this.app.workspace.getActiveFile();
    const out = [];
    for (const f of getAllIRFiles(this.app)) {
      if (skipCurrent && active && f.path === active.path) continue;
      const fm = getFm(this.app, f);
      if (!isActiveIR(fm)) continue;
      if (!isDue(fm, today)) continue;
      out.push({ tfile: f, fm });
    }
    // Inline cards live in `inline_cards[]` with no file of their own. Surface due
    // ones as synthetic `type:'card'` entries (tfile = parent) so the interleaved
    // queue, Next Element and Random Due treat them like any other card.
    if (this.settings.inline_cards.enabled) {
      for (const f of getAllIRFiles(this.app)) {
        const fm = getFm(this.app, f);
        if (!isActiveIR(fm) || (fm.type !== 'source' && fm.type !== 'extract')) continue;
        for (const c of (fm.inline_cards || [])) {
          if (c.status === 'done' || c.status === 'dismissed') continue;
          const cardFm = inlineCardFm(c, fm, f.path);
          if (!isDue(cardFm, today)) continue;
          out.push({ tfile: f, fm: cardFm });
        }
      }
    }
    return out;
  }

  // Dashboard reads `card_ratio` from its own frontmatter (SM-canon items:topics
  // ratio, default 5 cards per 1 topic). The plugin's Next Element interleaves
  // identically so the picker order matches what the dashboard's "Today's
  // Session" table displays as #1, #2, #3…
  getCardRatio() {
    const dash = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!dash) return 5;
    const fm = this.app.metadataCache.getFileCache(dash)?.frontmatter;
    const v = Number(fm?.card_ratio);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 5;
  }

  // Read the dashboard's session snapshot (path list persisted as
  // `today_session_paths`). Returns active, not-reviewed-today items in
  // snapshot order. Null if no fresh snapshot exists.
  readSessionSnapshot() {
    const dash = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!dash) return null;
    const fm = getFm(this.app, dash);
    const todayStr = todayDMY();
    if (!fm || fm.today_session_date !== todayStr) return null;
    const paths = fm.today_session_paths;
    if (!Array.isArray(paths) || paths.length === 0) return null;
    const today = todayDate();
    const out = [];
    const seen = new Set();
    for (const p of paths) {
      if (seen.has(p)) continue;   // drop duplicate snapshot keys
      seen.add(p);
      if (typeof p === 'string' && p.includes('::card::')) {
        const sep = p.indexOf('::card::');
        const parentPath = p.slice(0, sep);
        const cardId = p.slice(sep + '::card::'.length);
        const tf = this.app.vault.getAbstractFileByPath(parentPath);
        if (!tf) continue;
        const pfm = getFm(this.app, tf);
        const c = (pfm?.inline_cards || []).find(x => x.id === cardId);
        if (!c || c.status === 'done' || c.status === 'dismissed') continue;
        if (c.last_reviewed === todayStr) continue;
        const cardFm = inlineCardFm(c, pfm, parentPath);
        // Gate on isDue so stale snapshot entries (graded → future, or postponed)
        // can't inflate the "items left" count. Without this the snapshot keeps
        // not-due rows it once held, and the count oscillates as it churns.
        if (!isDue(cardFm, today)) continue;
        out.push({ tfile: tf, fm: cardFm });
        continue;
      }
      const tf = this.app.vault.getAbstractFileByPath(p);
      if (!tf) continue;
      const f = getFm(this.app, tf);
      if (!isActiveIR(f)) continue;
      if (f.last_reviewed === todayStr) continue;
      if (!isDue(f, today)) continue;
      out.push({ tfile: tf, fm: f });
    }
    return out;
  }

  async persistSessionSnapshot(queue) {
    const dash = this.app.vault.getAbstractFileByPath(DASHBOARD_PATH);
    if (!dash) return;
    // Inline cards share their parent's path, so encode them as `parent::card::id`
    // to preserve identity across reload; plain file entries stay as bare paths.
    const paths = queue
      .map(q => q.fm?.inline_parent ? `${q.fm.inline_parent}::card::${q.fm.id}` : q.tfile?.path)
      .filter(Boolean);
    if (!paths.length) return;
    try {
      await this.app.fileManager.processFrontMatter(dash, (fm) => {
        fm.today_session_paths = paths;
        fm.today_session_date = todayDMY();
      });
    } catch (e) {
      console.error('[IR] persistSessionSnapshot failed', e);
    }
  }

  buildInterleavedQueue(pool, today) {
    const topics = pool.filter(p => p.fm.type !== 'card')
      .sort((a, b) => urgency(b.fm, today) - urgency(a.fm, today));
    const cards = pool.filter(p => p.fm.type === 'card')
      .sort((a, b) => urgency(b.fm, today) - urgency(a.fm, today));
    const ratio = this.getCardRatio();
    const queue = [];
    let ti = 0, ci = 0;
    while (ti < topics.length || ci < cards.length) {
      if (ti < topics.length) queue.push(topics[ti++]);
      const take = Math.min(ratio, cards.length - ci);
      for (let k = 0; k < take; k++) queue.push(cards[ci++]);
      if (ti >= topics.length && take === 0) break;
    }
    return queue;
  }

  async nextElement() {
    const active = this.app.workspace.getActiveFile();
    let queue = this.readSessionSnapshot();
    if (queue && queue.length) {
      // Drop the currently-open file so Next advances, but keep inline cards even
      // when their parent is the active file — they grade in place, not by opening.
      queue = queue.filter(p => p.fm?.inline_parent || !active || p.tfile.path !== active.path);
    } else {
      const pool = this.buildDuePool();
      if (pool.length === 0) { new Notice('✨ Nothing due. Caught up.'); return; }
      queue = this.buildInterleavedQueue(pool, todayDate());
      // Persist so dashboard renders the same order on next open.
      await this.persistSessionSnapshot(queue);
    }
    if (!queue || queue.length === 0) { new Notice('✨ Caught up.'); return; }

    // Inline cards have no file to open + grade via hotkey, so grade any that sit at
    // the front of the queue in place (modal) before opening the next file element.
    // Iterate the in-memory queue rather than recursing through the snapshot — the
    // metadataCache lags processFrontMatter, so a re-read could re-present a card we
    // just graded. A cancelled grade (falsy) stops the burst and leaves the rest.
    let i = 0;
    while (i < queue.length && queue[i].fm?.inline_parent) {
      const graded = await this._reviewInlineCard(queue[i].fm.inline_parent, queue[i].fm.id);
      if (!graded) return;
      i++;
    }
    if (i >= queue.length) { new Notice('✨ Caught up.'); return; }
    const next = queue[i];
    await this.app.workspace.getLeaf(false).openFile(next.tfile);
    const action = next.fm.type === 'source' ? '📖 Read' :
      (next.fm.type === 'card' ? '🃏 Recall' : '📝 Process');
    new Notice(`${action}: ${next.tfile.basename} · p${next.fm.priority ?? '—'} · ${queue.length - i - 1} more in queue`);
  }

  async randomDue() {
    const pool = this.buildDuePool();
    if (pool.length === 0) { new Notice('✨ Nothing due. Caught up.'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick.fm?.inline_parent) {
      await this._reviewInlineCard(pick.fm.inline_parent, pick.fm.id);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(pick.tfile);
    const action = pick.fm.type === 'source' ? '📖 Read' :
      (pick.fm.type === 'card' ? '🃏 Recall' : '📝 Process');
    new Notice(`🎲 ${action}: ${pick.tfile.basename} · p${pick.fm.priority ?? '—'} (1 of ${pool.length} due)`);
  }

  async gradeAndAdvance() {
    await this.endSession();
    await this.nextElement();
  }

  // ---- End Session (FSRS card + A-Factor topic) --------------------------

  async endSession() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') {
      new Notice('Open an IR source / extract / card first.');
      return;
    }
    const fm = getFm(this.app, active);
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card')) {
      new Notice('Active note is not an IR element.');
      return;
    }
    const today = todayDMY();

    if (fm.type === 'card') {
      await this._gradeCard(active, fm, today);
      return;
    }
    await this._gradeTopic(active, fm, today);
  }

  async _gradeCard(file, fm, today) {
    let qMd, aMd, hideLabels = false;
    const isOcclusion = fm.card_format === 'occlusion';

    if (fm.inline_parent) {
      // Inline cards render their own content, not the parent body.
      if (fm.type === 'card' && fm.question != null && fm.answer != null) {
        // qa inline card
        qMd = fm.question;
        aMd = fm.answer;
      } else if (fm.text != null) {
        // cloze inline card — mask this card's marker for the question, reveal for the answer.
        const line = fm.full_line || fm.text;
        const hlMarker = `==${fm.text}==`;
        if (line.includes(hlMarker)) {
          // ==highlight== style — mask only this card's occurrence (LaTeX-safe).
          qMd = line.split(hlMarker).join(fm.hint ? `[${fm.hint}]` : '[…]');
          aMd = line.split(hlMarker).join(`**${fm.text}**`);
        } else {
          // {{c1::...}} style.
          qMd = line.replace(/\{\{c\d+::([^}]+?)(?:::([^}]+?))?\}\}/g, (_, txt, hint) =>
            hint ? `[${hint}]` : '[…]');
          aMd = line.replace(/\{\{c\d+::([^}]+?)(?:::[^}]+?)?\}\}/g, (_, txt) => `**${txt}**`);
        }
      } else {
        // Fallback: best-effort echo.
        qMd = String(fm.text ?? fm.question ?? '');
        aMd = String(fm.answer ?? fm.text ?? '');
      }
    } else {
      const fullContent = await this.app.vault.read(file);
      let body = fullContent.replace(/^---\n[\s\S]*?\n---\n/, '');
      const idx = body.indexOf(BODY_MARKER);
      if (idx >= 0) body = body.slice(idx + BODY_MARKER.length);
      body = body.trim();

      if (isOcclusion) {
        // For occlusion both Q and A are the same code-block; the renderer's
        // built-in Show Answer button handles the visual reveal. The grade
        // modal acts as the framing UI.
        qMd = body;
        aMd = body;
        hideLabels = true;
      } else if (fm.card_format === 'cloze') {
        aMd = body;
        const clozeIdx = Number(fm.cloze_index);
        if (Number.isFinite(clozeIdx) && clozeIdx >= 1) {
          // Sibling card: hide only the Nth ==mark== (1-based), leave others visible.
          let seen = 0;
          qMd = body.replace(new RegExp(HL_CLOZE_SRC, 'g'), (_m, inner) => {
            seen++;
            return seen === clozeIdx ? '**[ … ]**' : inner;
          });
          qMd = qMd.replace(/\{\{([^}]+)\}\}/g, '$1');
        } else {
          qMd = body.replace(new RegExp(HL_CLOZE_SRC, 'g'), '**[ … ]**').replace(/\{\{([^}]+)\}\}/g, '**[ … ]**');
        }
      } else {
        // Basic: split on the [!answer] callout. Question is everything before.
        const m = body.match(/^([\s\S]*?)\n\n> \[!answer\][^\n]*\n([\s\S]*?)$/);
        if (m) {
          qMd = m[1].trim();
          // Strip "> " quote prefix to render answer as plain markdown
          aMd = m[2].replace(/^> ?/gm, '').trim();
        } else { qMd = body; aMd = body; }
      }
    }

    const grade = await reviewCard(this.app, {
      title: file.basename,
      sourcePath: file.path,
      questionMd: qMd,
      answerMd: aMd,
      hideLabels,
      directGrade: isOcclusion,
    });
    if (!grade) return false;
    const gradeLabel = ['', 'Again', 'Hard', 'Good', 'Easy'][grade];

    const lastDate = parseDMY(fm.last_reviewed);
    const todayDateObj = parseDMY(today);
    const elapsed = (lastDate && todayDateObj)
      ? Math.max(0, Math.round((todayDateObj - lastDate) / 86400000)) : 0;

    const ctx = fsrsCtx(this.settings);
    const isFirst = fm.stability == null || fm.stability === '';
    let sBefore = null, dBefore = null, rAt, sAfter, dAfter;
    if (isFirst) {
      rAt = 1.0;
      sAfter = ctx.w[grade - 1];
      dAfter = fsrsSeedDifficulty(ctx, grade);
    } else {
      sBefore = Number(fm.stability);
      dBefore = Number(fm.difficulty) || ctx.w[4];
      rAt = fsrsRetrievability(ctx, elapsed, sBefore);
      if (elapsed < 1 && this.settings.fsrs.short_term_enabled) {
        sAfter = fsrsShortTermStability(ctx, sBefore, grade);
      } else if (grade === 1) {
        sAfter = fsrsUpdateStabilityLapse(ctx, dBefore, sBefore, rAt);
      } else {
        sAfter = fsrsUpdateStabilityRecall(ctx, dBefore, sBefore, rAt, grade);
      }
      dAfter = fsrsUpdateDifficulty(ctx, dBefore, grade);
    }

    const interval = fsrsInterval(ctx, sAfter);
    const nextReview = futureDMY(interval);
    const reviewCount = (fm.review_count ?? 0) + 1;

    if (fm.inline_parent) {
      await updateInlineCardState(this.app, fm.inline_parent, fm.id, (c) => ({
        ...c,
        stability: round4(sAfter),
        difficulty: round4(dAfter),
        last_grade: grade,
        last_retrievability: round4(rAt ?? 0),
        last_reviewed: today,
        next_review: nextReview,
        interval,
        review_count: reviewCount,
        status: c.status === 'pending' || c.status === 'inbox' ? 'active' : (c.status || 'active'),
      }));
    } else {
      await this.app.fileManager.processFrontMatter(file, (fmw) => {
        fmw.stability = round4(sAfter);
        fmw.difficulty = round4(dAfter);
        fmw.last_grade = grade;
        fmw.last_retrievability = round4(rAt);
        fmw.last_reviewed = today;
        fmw.next_review = nextReview;
        fmw.interval = interval;
        fmw.review_count = reviewCount;
        if (fmw.status === 'inbox' || fmw.status === 'pending') fmw.status = 'active';
      });
    }

    const logFile = this.app.vault.getAbstractFileByPath(REVIEW_LOG_PATH);
    if (logFile) {
      const fmt = (v) => v == null ? '' : (typeof v === 'number' ? round4(v).toString() : String(v));
      const row = `| ${today} | [[${file.basename}]] | card | ${grade} | ${elapsed} | ${(rAt * 100).toFixed(1)}% | ${fmt(sBefore)} | ${fmt(sAfter)} | ${fmt(dBefore)} | ${fmt(dAfter)} |\n`;
      await this.app.vault.append(logFile, row);
    }
    let parentHint = '';
    if (grade <= 2) {
      const parentName = linkTarget(fm.source);
      if (parentName) parentHint = ` · Recall weak — revisit [[${parentName}]]?`;
    }
    new Notice(`Card: ${gradeLabel} → S ${round4(sAfter)}d, D ${round4(dAfter)}, next in ${interval}d (${nextReview})${parentHint}`);
    return grade;
  }

  async _gradeTopic(file, fm, today) {
    let newReadPoint = fm.read_point;
    let newReadPointSeconds = fm.read_point_seconds;
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
      const editor = getEditorForFile(this.app, file);
      const cursor = editor?.getCursor?.();
      if (editor && cursor) {
        const updateMarker = await confirmDialog(this.app, `Update 📍 to line ${cursor.line + 1}?`);
        if (updateMarker) {
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
    const progressAF = s.progress_aware ? progressAwareAFactor(fm, this.settings) : null;
    const baseAF = progressAF != null ? progressAF : priorAFactor;

    const qualityFactor = await pickFromList(
      this.app,
      ['Hold (no change)',
       `Speed up (×${s.quality_speed_up} — see sooner)`,
       `Slow down (×${s.quality_slow_down} — push out)`],
      [s.quality_hold, s.quality_speed_up, s.quality_slow_down],
      'Topic quality?'
    );
    const aFactor = qualityFactor != null
      ? clampAFactor(this.settings, baseAF * qualityFactor)
      : baseAF;

    const priorReps = fm.review_count ?? 0;
    const reviewCount = priorReps + 1;
    const isFirstRep = priorReps === 0 || !(Number(fm.interval) > 0);

    let interval = isFirstRep
      ? priorityToInterval(priority)
      : Math.max(1, Math.round(Number(fm.interval) * aFactor));

    // Stall guard: no growth if read_point did not advance.
    if (s.stall_guard && !isFirstRep) {
      const newReadPointVal = newReadPoint ?? prevReadPoint;
      const newReadSecondsVal = newReadPointSeconds ?? prevReadSeconds;
      const advanced =
        (Number.isFinite(newReadPointVal) && newReadPointVal > prevReadPoint) ||
        (Number.isFinite(newReadSecondsVal) && newReadSecondsVal > prevReadSeconds);
      if (!advanced) interval = Math.min(interval, Number(fm.interval) || interval);
    }

    const nextReview = futureDMY(interval);

    await this.app.fileManager.processFrontMatter(file, (fmw) => {
      fmw.interval = interval;
      fmw.review_count = reviewCount;
      fmw.next_review = nextReview;
      fmw.last_reviewed = today;
      fmw.a_factor = round4(aFactor);
      if (newReadPoint !== undefined && newReadPoint !== null) fmw.read_point = newReadPoint;
      if (newReadPointSeconds !== undefined && newReadPointSeconds !== null) fmw.read_point_seconds = newReadPointSeconds;
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

    // Log topic rep with empty grade/S/D so an FSRS optimizer treating grade as
    // numeric will skip these rows. A-Factor before/after captured in D cols
    // for inspection in dashboard / scripts (not used by FSRS).
    const logFile = this.app.vault.getAbstractFileByPath(REVIEW_LOG_PATH);
    if (logFile) {
      const elapsedDays = (() => {
        const lr = parseDMY(fm.last_reviewed);
        const tdy = parseDMY(today);
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
      new Notice('Sidebar disabled in IR Toolkit settings');
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

  // Build the tree index from every IR element. Limitation: nodes are keyed by
  // basename (case-insensitive), so two IR files sharing a basename in different
  // folders collide — the last one wins. Basenames are unique in practice; revisit
  // with path-based resolution if that stops holding.
  buildTreeIndex() {
    const pages = [];
    for (const f of getAllIRFiles(this.app)) {
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
    if (parentName) fm.push(`parent: "[[${parentName}]]"`);
    fm.push('tree_order: 0', 'tags:', '  - incremental-reading', '  - ir/category', '---', '', `# ${name}`, '');
    const file = await this.app.vault.create(path, fm.join('\n'));
    new Notice(`Category created: ${name}`);
    return file;
  }

  async reparent(childPath, newParentName) {
    const child = this.app.vault.getAbstractFileByPath(childPath);
    if (!child) { new Notice('Node not found'); return; }
    const idx = this.buildTreeIndex();
    if (newParentName && treeCore.wouldCreateCycle(idx, child.basename, newParentName)) {
      new Notice('Refused: would create a cycle'); return;
    }
    await this.app.fileManager.processFrontMatter(child, (fm) => {
      if (newParentName) fm.parent = `[[${newParentName}]]`;
      else delete fm.parent;
    });
    new Notice(newParentName ? `Moved under ${newParentName}` : 'Moved to top level');
    this._refreshTreeViews();
  }

  async reparentActive() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('No active markdown element'); return; }
    const fm = getFm(this.app, active);
    if (!fm || !['category', 'source', 'extract', 'card'].includes(fm.type)) {
      new Notice('Active note is not an IR element'); return;
    }
    const idx = this.buildTreeIndex();
    const candidates = [...idx.byName.values()].filter(p => p.fm.type !== 'card' && p.path !== active.path);
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
    const ok = await confirmDialog(this.app, `Dismiss "${f.basename}"?`,
      'Sets status: dismissed (kept in the tree, removed from the review queue).');
    if (!ok) return;
    await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = 'dismissed'; });
    new Notice('Dismissed');
    this._refreshTreeViews();
  }

  // Returns the grade (1-4) if the card was graded, or false if the parent/card
  // was missing or the user cancelled the modal. Callers (e.g. nextElement) rely
  // on the falsy result to stop advancing rather than re-presenting the same card.
  async _reviewInlineCard(parentPath, cardId) {
    const parentFile = this.app.vault.getAbstractFileByPath(parentPath);
    if (!parentFile) { new Notice('Inline parent file not found'); return false; }
    const parentCache = this.app.metadataCache.getFileCache(parentFile);
    const card = (parentCache?.frontmatter?.inline_cards || []).find(c => c.id === cardId);
    if (!card) { new Notice('Inline card not found'); return false; }

    // Open the parent so the user has context; non-blocking.
    await this.app.workspace.getLeaf(false).openFile(parentFile);

    const syntheticFm = inlineCardFm(card, parentCache?.frontmatter, parentPath);
    return await this._gradeCard(parentFile, syntheticFm, todayDMY());
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
    const parsedIds = new Set(parsed.map(c => c.id));
    const existing = new Set((fm.inline_cards || []).map(c => c.id));
    const newCards = parsed.filter(c => !existing.has(c.id));

    // The id is a hash of file path + literal, so editing a card's own text mints a
    // new id and orphans the old entry — re-seeding would then leave a stale duplicate.
    // Prune orphans (literal no longer in the body) that were never reviewed; keep
    // reviewed ones since their FSRS history is worth preserving (dismiss manually).
    const isReviewed = (c) => c.review_count > 0 || c.last_reviewed != null || c.stability != null;
    const orphans = (fm.inline_cards || []).filter(c => !parsedIds.has(c.id) && !isReviewed(c));

    if (!newCards.length && !orphans.length) { new Notice('No new inline cards found'); return; }

    await this.app.fileManager.processFrontMatter(active, (fmw) => {
      fmw.inline_cards = fmw.inline_cards || [];
      if (orphans.length) {
        const drop = new Set(orphans.map(c => c.id));
        fmw.inline_cards = fmw.inline_cards.filter(c => !drop.has(c.id));
      }
      for (const c of newCards) {
        fmw.inline_cards.push({
          ...c,
          status: 'pending',
          priority: fmw.priority ?? 50,
        });
      }
    });
    const parts = [];
    if (newCards.length) parts.push(`seeded ${newCards.length}`);
    if (orphans.length) parts.push(`pruned ${orphans.length} edited/removed`);
    new Notice(`Inline cards: ${parts.join(' · ')}`);
  }

  async addCheckpoint(noteOverride) {
    const active = this.app.workspace.getActiveFile();
    if (!active) { new Notice('No active file'); return; }
    const cache = this.app.metadataCache.getFileCache(active);
    if (!isActiveIR(cache?.frontmatter)) { new Notice('Not an active IR element'); return; }

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
        date: todayDMY(),
        line,
        note: cleanNote,
        ...(fm.type === 'source' && fm.read_point_seconds != null ? { read_point_seconds: fm.read_point_seconds } : {}),
      });
      if (interval != null) {
        fm.interval = interval;
        fm.next_review = futureDMY(interval);
      }
    });

    new Notice(interval != null ? `Checkpoint saved, next in ${interval}d` : 'Checkpoint saved');
  }

  // ---- Done / Dismiss / Postpone / Schedule / Forget ---------------------

  async markDone() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
    if (!r) return;
    const { tfile, fm } = r;
    if (fm.status === 'done') { new Notice('Already done.'); return; }
    const labels = { source: 'Source', extract: 'Extract', card: 'Card' };
    if (!(await confirmDialog(this.app, `Mark ${labels[fm.type]} as done?`))) return;
    await this.app.fileManager.processFrontMatter(tfile, (fmw) => {
      fmw.status = 'done';
      fmw.last_reviewed = todayDMY();
    });
    new Notice(`${labels[fm.type]} marked done.`);
  }

  async dismiss() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
    if (!r) return;
    const { tfile, fm } = r;
    if (fm.status === 'dismissed') { new Notice('Already dismissed.'); return; }
    await this.app.fileManager.processFrontMatter(tfile, (fmw) => {
      fmw.status = 'dismissed';
      fmw.date_dismissed = todayDMY();
    });
    new Notice('Dismissed. Set status: active to restore.');
  }

  async postpone() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
    if (!r) return;
    const choice = await pickFromList(
      this.app,
      ['Tomorrow (+1d)', '+3 days', '+1 week', '+2 weeks'],
      [1, 3, 7, 14],
      'Postpone how long?'
    );
    if (!choice) return;
    const newDate = futureDMY(choice);
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      fmw.next_review = newDate;
      // Cards keep their FSRS-derived interval (reflects stability). Topics
      // get the raw postpone window since their interval is the scheduler input.
      if (r.fm.type !== 'card') fmw.interval = choice;
    });
    new Notice(`Postponed +${choice}d · Next review: ${newDate}`);
  }

  async schedule() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
    if (!r) return;
    const cur = r.fm.next_review || '(unscheduled)';
    const raw = await askText(this.app, `Schedule (DD-MM-YYYY or +Nd/-Nd; current: ${cur})`, '');
    if (!raw || raw.trim() === '') return;
    const input = raw.trim();

    let newDate = null;
    const offset = input.match(/^([+-]?)(\d+)\s*d?$/i);
    const dateM = input.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (offset) {
      const sign = offset[1] === '-' ? -1 : 1;
      newDate = futureDMY(sign * parseInt(offset[2], 10));
    } else if (dateM) {
      const [, dd, mm, yyyy] = dateM;
      const probe = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
      if (isNaN(probe.getTime()) || formatDMY(probe) !== `${dd}-${mm}-${yyyy}`) {
        new Notice(`Invalid date: ${input}`); return;
      }
      newDate = `${dd}-${mm}-${yyyy}`;
    } else {
      new Notice(`Couldn't parse: "${input}".`); return;
    }
    const oldParsed = parseDMY(r.fm.next_review);
    const newParsed = parseDMY(newDate);
    const newInterval = newParsed ? Math.max(1, Math.round((newParsed - todayDate()) / 86400000)) : null;
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      fmw.next_review = newDate;
      if (newInterval != null && r.fm.type !== 'card') fmw.interval = newInterval;
    });
    new Notice(`Scheduled: ${cur} → ${newDate}`);
  }

  async forgetCard() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: false });
    if (!r) return;
    if (r.fm.type !== 'card') { new Notice('Forget applies to cards only.'); return; }
    const priority = r.fm.priority ?? 50;
    const interval = priorityToInterval(priority);
    const nextReview = futureDMY(interval);
    if (!(await confirmDialog(this.app, `Clear FSRS state and reschedule for ${nextReview} (priority ${priority})?`))) return;
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
      delete fmw.stability;
      delete fmw.difficulty;
      delete fmw.last_grade;
      delete fmw.last_retrievability;
      delete fmw.review_count;
      fmw.last_reviewed = null;
      fmw.next_review = nextReview;
      fmw.interval = 1;
      fmw.status = 'pending';
    });
    new Notice(`Card forgotten · FSRS cleared · next ${nextReview}.`);
  }

  // ---- Set Priority / Boost ---------------------------------------------

  async setPriority() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
    if (!r) return;
    const cur = r.fm.priority ?? 50;
    const raw = await askText(this.app, 'New priority (1-100, 1=highest)', String(cur));
    if (raw === null) return;
    const p = parseInt(raw, 10);
    if (isNaN(p) || p < 1 || p > 100) { new Notice('Invalid priority — integer 1-100.'); return; }
    await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => { fmw.priority = p; });
    const sched = r.fm.type === 'card' ? 'FSRS-driven' : 'A-Factor-driven';
    new Notice(`Priority → ${p} (next_review unchanged — ${sched})`);
  }

  async boost() {
    const r = await resolveIRFromActive(this.app, { allowCard: true, allowPdfFallback: true });
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
      const subtree = walkSubtree(this.app, r.tfile.basename, r.tfile.path);
      for (const p of subtree) {
        if (p.tfile.path === r.tfile.path) continue;
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
    const r = await resolveSourceFromActive(this.app);
    if (!r) return;
    const filter = await pickFromList(
      this.app,
      ['All elements', 'Topics only', 'Cards only', 'Due / overdue only'],
      ['all', 'topics', 'cards', 'due'],
      'Filter subtree by'
    );
    if (!filter) return;

    const today = todayDate();
    let subset = walkSubtree(this.app, r.tfile.basename, r.tfile.path)
      .filter(p => p.tfile.path !== r.tfile.path);
    if (filter === 'topics') subset = subset.filter(p => p.fm.type !== 'card');
    else if (filter === 'cards') subset = subset.filter(p => p.fm.type === 'card');
    else if (filter === 'due') subset = subset.filter(p => isDue(p.fm, today));
    subset = subset.filter(p => p.fm.status !== 'done' && p.fm.status !== 'container' && p.fm.status !== 'dismissed');
    if (subset.length === 0) { new Notice(`No descendants match.`); return; }

    subset.sort((a, b) => urgency(b.fm, today) - urgency(a.fm, today));
    const statusIcon = (fm) => {
      const nr = parseDMY(fm.next_review);
      if (!nr) return '⚪';
      const off = daysBetween(today, nr);
      return off > 0 ? '🔴' : (off === 0 ? '🟡' : '🟢');
    };
    const picked = await pickFuzzy(
      this.app,
      subset,
      p => {
        const t = p.fm.type === 'source' ? '📖' : (p.fm.type === 'card' ? '🃏' : '📝');
        return `${t} ${statusIcon(p.fm)} p${p.fm.priority ?? '—'} u${urgency(p.fm, today).toFixed(0)}  ${p.tfile.basename}`;
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
    for (const f of getAllIRFiles(this.app)) {
      const fm = getFm(this.app, f);
      if (!isActiveIR(fm)) continue;
      if (!isPastDue(fm, today)) continue;
      overdue.push({ tfile: f, fm });
    }
    if (overdue.length === 0) { new Notice('Nothing overdue.'); return; }
    overdue.sort((a, b) => urgency(b.fm, today) - urgency(a.fm, today));
    let updated = 0;
    for (let rank = 0; rank < overdue.length; rank++) {
      const off = Math.floor(rank * choice / overdue.length);
      const d = new Date(today.getTime()); d.setDate(d.getDate() + off);
      const newDate = formatDMY(d);
      await this.app.fileManager.processFrontMatter(overdue[rank].tfile, (fmw) => { fmw.next_review = newDate; fmw.interval = Math.max(1, off); });
      updated++;
    }
    new Notice(`Mercy: ${updated} overdue spread across ${choice}d.`);
  }

  async postponeSubtree() {
    const r = await resolveSourceFromActive(this.app);
    if (!r) return;
    const choice = await pickFromList(
      this.app,
      ['+1d', '+3d', '+1 week', '+2 weeks', '+1 month'],
      [1, 3, 7, 14, 30],
      'Postpone subtree by'
    );
    if (!choice) return;
    const subtree = walkSubtree(this.app, r.tfile.basename, r.tfile.path);
    let postponed = 0;
    for (const p of subtree) {
      const fm = p.fm;
      if (fm.status === 'done' || fm.status === 'container' || fm.status === 'dismissed') continue;
      let baseDate = todayDMY();
      if (fm.next_review) {
        const dm = String(fm.next_review).match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (dm) {
          const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
          const todayIso = formatDMY(todayDate()).split('-').reverse().join('-');
          if (iso > todayIso) baseDate = fm.next_review;
        }
      }
      const baseObj = parseDMY(baseDate) || todayDate();
      baseObj.setDate(baseObj.getDate() + choice);
      const newDate = formatDMY(baseObj);
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
    const r = await resolveSourceOrExtractFromActive(this.app);
    if (!r) return;
    let clip = '';
    try { clip = (await navigator.clipboard.readText()).trim(); }
    catch (e) { new Notice('Could not read clipboard.'); return; }
    if (!clip) { new Notice('Clipboard empty.'); return; }
    await this._writeExtract(r.tfile, r.fm, clip);
  }

  async _writeExtract(sourceFile, fm, body) {
    const sourceTitle = sourceFile.basename;
    const priority = fm.priority ?? 50;
    const today = todayDMY();
    const existing = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(EXTRACTS_FOLDER + '/') &&
      f.basename.startsWith(sourceTitle + ' - Extract')
    );
    const n = existing.length + 1;
    const name = `${sourceTitle} - Extract ${n}`;
    const autoInterval = priorityToInterval(priority);

    const customStr = await askText(this.app, `First interval in days (blank for auto: ${autoInterval}d)`, '');
    const interval = (customStr && Number.isFinite(Number(customStr)))
      ? Math.max(1, Math.round(Number(customStr))) : autoInterval;
    const nextReview = futureDMY(interval);

    const content = `---
type: extract
source: "[[${sourceTitle}]]"
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
    const path = `${EXTRACTS_FOLDER}/${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Extract already exists at ${path}`); return;
    }
    await this.app.vault.create(path, content);
    const decayCap = Math.min(100, priority + 30);
    const newPri = Math.min(decayCap, priority + 1);
    if (newPri !== priority) {
      await this.app.fileManager.processFrontMatter(sourceFile, (fmw) => { fmw.priority = newPri; });
    }
    const bump = await this._bumpAFactor(sourceFile, fm, A_FACTOR_BUMP_EXTRACT);
    const bumpMsg = bump ? ` · a ${bump.from}→${bump.to}` : '';
    new Notice(`Extract: ${name} · p${priority}→${newPri} · review +${interval}d (${nextReview})${bumpMsg}`);
  }

  async flashcardClipboard() {
    this._dbg('flashcardClipboard start');
    const r = await resolveSourceOrExtractFromActive(this.app);
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
    const parentPriority = fm.priority ?? 50;
    const today = todayDMY();
    // New cards schedule to TOMORROW so they don't barge into today's
    // session. First grading (whenever it lands) seeds FSRS from W[grade-1]
    // regardless — there's no learning-phase penalty for the deferral.
    const initialInterval = 1;
    const nextReview = futureDMY(1);

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

    const existing = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(CARDS_FOLDER + '/') &&
      f.basename.startsWith(parentTitle + ' - Card')
    );
    const cardNum = existing.length + 1;
    const SPACER = `<div style="height: 90vh;"></div>\n\n${BODY_MARKER}\n\n`;

    const buildBody = (q, a, fmt) => {
      if (fmt === 'cloze') return `${q}\n`;
      return `${q}\n\n> [!answer]- Answer\n> ${a.replace(/\n/g, '\n> ')}\n`;
    };

    const buildContent = (q, a, fmt, extraFmLines = '') => `---
type: card
source: "[[${parentTitle}]]"
status: pending
priority: ${parentPriority}
next_review: ${nextReview}
interval: ${initialInterval}
review_count: 0
last_reviewed:
last_grade:
last_retrievability:
stability:
difficulty:
date_added: ${today}
card_format: ${fmt}${extraFmLines}
cssclasses:
  - hide-answer
tags:
  - incremental-reading
  - ir/card
---

${SPACER}${buildBody(q, a, fmt)}`;

    if (cardFormat === 'reverse') {
      const fwdName = `${parentTitle} - Card ${cardNum}`;
      const revName = `${parentTitle} - Card ${cardNum + 1}`;
      await this.app.vault.create(`${CARDS_FOLDER}/${fwdName}.md`,
        buildContent(questionText, answerText, 'basic'));
      await this.app.vault.create(`${CARDS_FOLDER}/${revName}.md`,
        buildContent(answerText, questionText, 'basic'));
      new Notice(`Reverse pair: ${fwdName} + ${revName}`);
    } else if (cardFormat === 'cloze') {
      // Generate one card per ==mark== (SM canon: sibling cards share text,
      // each hides exactly one deletion). cloze_index is 1-based.
      const marks = [...questionText.matchAll(new RegExp(HL_CLOZE_SRC, 'g'))];
      const n = marks.length;
      if (n <= 1) {
        const name = `${parentTitle} - Card ${cardNum}`;
        await this.app.vault.create(`${CARDS_FOLDER}/${name}.md`,
          buildContent(questionText, answerText, 'cloze', `\ncloze_index: 1`));
        new Notice(`Card created: ${name} · priority ${parentPriority}`);
      } else {
        const names = [];
        for (let i = 0; i < n; i++) {
          const name = `${parentTitle} - Card ${cardNum + i}`;
          await this.app.vault.create(`${CARDS_FOLDER}/${name}.md`,
            buildContent(questionText, answerText, 'cloze', `\ncloze_index: ${i + 1}`));
          names.push(name);
        }
        new Notice(`Cloze siblings: ${n} cards (one per ==mark==)`);
      }
    } else {
      const name = `${parentTitle} - Card ${cardNum}`;
      await this.app.vault.create(`${CARDS_FOLDER}/${name}.md`,
        buildContent(questionText, answerText, cardFormat));
      new Notice(`Card created: ${name} · priority ${parentPriority}`);
    }
  }

  // Build a basic image-based flashcard (image is the question, user supplies
  // text answer). Image saved into the parent's attachment folder, embedded
  // via vault-relative wikilink. Pass either { imgClip } (binary from clipboard)
  // or { vaultPath } (existing image already in vault). skipCaption=true omits
  // the caption prompt — used for the pure "name this image" flashcard type.
  async _flashcardFromImage(parentFile, fm, { imgClip, vaultPath, skipCaption } = {}) {
    const parentTitle = parentFile.basename;
    const parentPriority = fm.priority ?? 50;
    const today = todayDMY();
    const initialInterval = 1;
    const nextReview = futureDMY(1);

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
      ? `${caption.trim()}\n\n![[${imgPath}]]`
      : `![[${imgPath}]]`;
    const answerText = answer.trim();

    const existing = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(CARDS_FOLDER + '/') &&
      f.basename.startsWith(parentTitle + ' - Card')
    );
    const cardNum = existing.length + 1;
    const name = `${parentTitle} - Card ${cardNum}`;
    const SPACER = `<div style="height: 90vh;"></div>\n\n${BODY_MARKER}\n\n`;
    const content = `---
type: card
source: "[[${parentTitle}]]"
status: pending
priority: ${parentPriority}
next_review: ${nextReview}
interval: ${initialInterval}
review_count: 0
last_reviewed:
last_grade:
last_retrievability:
stability:
difficulty:
date_added: ${today}
card_format: basic
cssclasses:
  - hide-answer
tags:
  - incremental-reading
  - ir/card
---

${SPACER}${questionText}\n\n> [!answer]- Answer\n> ${answerText.replace(/\n/g, '\n> ')}\n`;
    await this.app.vault.create(`${CARDS_FOLDER}/${name}.md`, content);
    new Notice(`Image card: ${name} · priority ${parentPriority}`);
  }

  // "Name this image" flashcard: image is the only thing on the front,
  // user types the name on the back. Pulls image from clipboard if present,
  // otherwise picks from the parent's embedded images or attachment folder.
  async flashcardImageName() {
    const r = await resolveSourceOrExtractFromActive(this.app);
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
    const folderFiles = this.app.vault.getFiles().filter(f =>
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
    const r = await resolveSourceOrExtractFromActive(this.app);
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
    const r = await resolveSourceOrExtractFromActive(this.app);
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
      const files = this.app.vault.getFiles().filter(f =>
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

    const parentTitle = (r.fm.type === 'source')
      ? r.tfile.basename
      : (() => {
          const link = String(r.fm.source || '').match(/\[\[([^\]|#]+)/);
          return link ? link[1] : r.tfile.basename;
        })();
    const parentPriority = r.fm.priority ?? 50;
    const today = todayDMY();
    const nextReview = futureDMY(1);

    const existing = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(CARDS_FOLDER + '/') &&
      f.basename.startsWith(parentTitle + ' - Card')
    );
    let cardNum = existing.length + 1;
    let written = 0;

    const yamlRects = result.rects
      .map(rect => {
        const base = `x: ${round4(rect.x)}, y: ${round4(rect.y)}, w: ${round4(rect.w)}, h: ${round4(rect.h)}`;
        const label = rect.label ? `, label: "${String(rect.label).replace(/"/g, '\\"')}"` : '';
        return `  - {${base}${label}}`;
      })
      .join('\n');

    for (const spec of cardSpecs) {
      const name = `${parentTitle} - Card ${cardNum}`;
      const body = `<div style="height: 90vh;"></div>\n\n${BODY_MARKER}\n\n` +
        '```ir-occlusion\n' +
        `image: ${resolvedPath}\n` +
        `mode: ${result.mode}\n` +
        `question_index: ${spec.questionIndex}\n` +
        'rects:\n' + yamlRects + '\n' +
        '```\n';
      const content = `---
type: card
source: "[[${parentTitle}]]"
status: pending
priority: ${parentPriority}
next_review: ${nextReview}
interval: 1
review_count: 0
last_reviewed:
last_grade:
last_retrievability:
stability:
difficulty:
date_added: ${today}
card_format: occlusion
occlusion_image: "${resolvedPath}"
occlusion_mode: ${result.mode}
occlusion_question_index: ${spec.questionIndex}
cssclasses:
  - hide-answer
tags:
  - incremental-reading
  - ir/card
---

${body}`;
      await this.app.vault.create(`${CARDS_FOLDER}/${name}.md`, content);
      cardNum++;
      written++;
    }

    new Notice(`Occlusion: ${written} card(s) from ${result.rects.length} rect(s) [${result.mode}]`);
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
    const pNum = parseInt(priStr, 10) || 50;

    const today = todayDMY();
    const interval = priorityToInterval(pNum);
    const nextReview = futureDMY(interval);

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
      const videos = this.app.vault.getFiles()
        .filter(f => f.path.startsWith(`${SOURCES_FOLDER}/Videos/`) && /\.(mp4|webm|mov|mkv)$/i.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (videos.length === 0) {
        new Notice(`Drop a video into ${SOURCES_FOLDER}/Videos/ first.`); return;
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
    if (sioyek_path)                 fmLines.push(`sioyek_path: "${sioyek_path}"`);
    if (source_url)                  fmLines.push(`source_url: "${source_url}"`);
    if (video_url)                   fmLines.push(`video_url: "${video_url}"`);
    if (video_id)                    fmLines.push(`video_id: "${video_id}"`);
    if (video_path)                  fmLines.push(`video_path: "${video_path}"`);
    if (read_point_seconds !== null) fmLines.push(`read_point_seconds: ${read_point_seconds}`);
    if (total_seconds !== null)      fmLines.push(`total_seconds: ${total_seconds}`);
    if (author)                      fmLines.push(`author: "${author}"`);
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

    const path = `${SOURCES_FOLDER}/${title}.md`;
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
    if (existing?.type === 'source') { new Notice('Already an IR source.'); return; }

    const priStr = await askText(this.app, 'Priority (1-100, 1=highest)', '50');
    if (priStr === null) return;
    const p = parseInt(priStr, 10);
    if (isNaN(p) || p < 1 || p > 100) { new Notice('Invalid priority.'); return; }

    const today = todayDMY();
    const interval = priorityToInterval(p);
    const nextReview = futureDMY(interval);
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

    const newPath = `${SOURCES_FOLDER}/${active.name}`;
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
      new Notice('Not an IR element.'); return;
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
    const r = await resolveSourceFromActive(this.app);
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
    const r = await resolveSourceFromActive(this.app);
    if (!r) return;
    const fm = r.fm;
    if (!fm.sioyek_path) { new Notice('No sioyek_path set.'); return; }
    const ps = Number(fm.page_start) || null, pe = Number(fm.page_end) || null, rp = Number(fm.read_point) || null;
    let page = (rp && ps && pe) ? Math.max(ps, Math.min(rp, pe)) : (rp || ps || 1);
    const { execFile } = require('child_process');
    execFile('/opt/homebrew/bin/sioyek', ['--page', String(page), fm.sioyek_path], (err) => {
      if (err) new Notice('Failed to open Sioyek: ' + err.message);
      else new Notice(`Opened in Sioyek at page ${page}`);
    });
  }

  async toggleReadPoint() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Open a markdown source.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not an IR source.'); return; }
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
    new Notice(action === 'clear' ? '📍 cleared.' : `📍 ${action} at line ${cursor.line + 1}`);
  }

  async jumpToReadPoint() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') { new Notice('Not a markdown source.'); return; }
    const fm = getFm(this.app, active);
    if (!fm || fm.type !== 'source') { new Notice('Not an IR source.'); return; }
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
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    let nSrc = 0, nExt = 0, nCard = 0;
    let nDone = 0, nDismissed = 0, nInbox = 0;
    let overdue = 0, dueToday = 0, future = 0;
    let todayRev = 0, weekRev = 0;
    let todaySrc = 0, todayExt = 0, todayCard = 0;
    for (const f of getAllIRFiles(this.app)) {
      const fm = getFm(this.app, f);
      if (!fm) continue;
      if (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card') continue;
      if (fm.status === 'done') { nDone++; continue; }
      if (fm.status === 'dismissed') { nDismissed++; continue; }
      if (fm.status === 'container') continue;
      if (fm.status === 'inbox') { nInbox++; continue; }
      if (fm.type === 'source') nSrc++;
      else if (fm.type === 'extract') nExt++;
      else nCard++;
      const nr = parseDMY(fm.next_review);
      if (nr) {
        const diff = daysBetween(today, nr);
        if (diff > 0) overdue++;
        else if (diff === 0) dueToday++;
        else future++;
      } else dueToday++;
      const lr = parseDMY(fm.last_reviewed);
      if (lr) {
        if (lr.getTime() === today.getTime()) {
          todayRev++;
          if (fm.type === 'source') todaySrc++;
          else if (fm.type === 'extract') todayExt++;
          else todayCard++;
        }
        if (lr >= weekAgo) weekRev++;
      }
    }

    let lifetime = 0, recentGrades = [];
    const logFile = this.app.vault.getAbstractFileByPath(REVIEW_LOG_PATH);
    if (logFile) {
      const log = await this.app.vault.read(logFile);
      const rows = log.split('\n').filter(l => /^\|\s*\d{2}-\d{2}-\d{4}/.test(l));
      lifetime = rows.length;
      for (const row of rows) {
        const cols = row.split('|').map(c => c.trim());
        const date = parseDMY(cols[1]);
        const grade = parseInt(cols[4], 10);
        if (date && date >= monthAgo && Number.isFinite(grade)) recentGrades.push(grade);
      }
    }
    const recall = recentGrades.filter(g => g >= 2).length;
    const retention = recentGrades.length > 0
      ? `${(100 * recall / recentGrades.length).toFixed(1)}% (${recall}/${recentGrades.length})` : 'n/a';

    const lines = [
      '**IR Stats**', '',
      `📊 Active: ${nSrc + nExt + nCard} (${nSrc}s / ${nExt}x / ${nCard}c)`,
      `📅 Queue: 🔴 ${overdue} overdue · 🟡 ${dueToday} due today · 🟢 ${future} scheduled`,
      `📦 Inbox: ${nInbox} · ✅ Done: ${nDone} · 🚫 Dismissed: ${nDismissed}`, '',
      `🔥 Today: ${todayRev} reviewed (${todaySrc}s / ${todayExt}x / ${todayCard}c)`,
      `📆 Last 7 days: ${weekRev} reviewed`,
      `🗂️ Lifetime log: ${lifetime} grades`,
      `🎯 30d card retention: ${retention}`,
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

    const today = todayDMY();
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
      const nextReview = futureDMY(interval);
      const noteTitle = `${parentTitle} — ${h.title}`;
      const noteContent = `---
type: source
source_type: article
status: active
parent: "[[${parentTitle}]]"
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
    await this.app.vault.modify(active, bodyWithoutOld + subSection);
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
    const dateAdded = fm.date_added ?? todayDMY();
    const folder = SOURCES_FOLDER;
    let created = 0;
    const skipped = [];

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const num = String(i + 1).padStart(2, '0');
      const safeTitle = ch.title.replace(/[\/\\:*?"<>|]/g, '').trim();
      const name = `${parentTitle} - Ch${num} ${safeTitle}`;
      const path = `${folder}/${name}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) { skipped.push(name); continue; }

      const chInterval = baseInterval + i;
      const chNext = futureDMY(chInterval);
      const chPages = (ch.end != null && ch.start != null) ? Math.max(1, ch.end - ch.start + 1) : null;
      const chAFactor = round4(initialAFactor(this.settings, { total_pages: chPages }));

      const content = `---
type: source
source_type: ${sourceType}
status: active
priority: ${priority}
parent: "[[${parentTitle}]]"
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
sioyek_path: ${sioyekPath ? '"' + sioyekPath + '"' : ''}
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
        const safeTitle = ch.title.replace(/[\/\\:*?"<>|]/g, '').trim();
        return `- [[${parentTitle} - Ch${num} ${safeTitle}]] (p.${ch.start}–${ch.end})`;
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

module.exports = IRToolkit;
