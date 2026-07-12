'use strict';
// Pure, Obsidian-free tree logic for the Incremental Reading knowledge tree.
// A "page" is a plain object: { path, basename, fm }.

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

module.exports = { linkTargetName, effectiveParent, siblingComparator, buildTreeIndex, wouldCreateCycle, computeReorder };
