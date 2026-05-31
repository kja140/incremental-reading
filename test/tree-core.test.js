'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { effectiveParent, buildTreeIndex, linkTargetName } = require('../tree-core.js');

const page = (path, basename, fm) => ({ path, basename, fm });

test('effectiveParent prefers parent over source', () => {
  assert.equal(effectiveParent({ parent: '[[Cat A]]', source: '[[Src X]]' }), 'Cat A');
  assert.equal(effectiveParent({ source: '[[Src X]]' }), 'Src X');
  assert.equal(effectiveParent({ parent: '[[Cat A|alias]]' }), 'Cat A');
  assert.equal(effectiveParent({ parent: '[[Cat A#heading]]' }), 'Cat A');
  assert.equal(effectiveParent({}), null);
  assert.equal(effectiveParent(null), null);
});

test('buildTreeIndex groups children under resolvable parents', () => {
  const pages = [
    page('Categories/Psych.md', 'Psych', { type: 'category', tree_order: 10 }),
    page('Sources/Book.md', 'Book', { type: 'source', parent: '[[Psych]]', tree_order: 20 }),
    page('Extracts/E1.md', 'E1', { type: 'extract', source: '[[Book]]', tree_order: 10 }),
    page('Sources/Loose.md', 'Loose', { type: 'source' }),
  ];
  const idx = buildTreeIndex(pages);
  assert.deepEqual(idx.roots.map(p => p.basename), ['Psych', 'Loose']);
  assert.deepEqual((idx.childrenOf.get('psych') || []).map(p => p.basename), ['Book']);
  assert.deepEqual((idx.childrenOf.get('book') || []).map(p => p.basename), ['E1']);
  assert.ok(idx.byName.has('book'));
});

test('buildTreeIndex sorts siblings by tree_order then name', () => {
  const pages = [
    page('a.md', 'Zeta', { type: 'source', tree_order: 10 }),
    page('b.md', 'Alpha', { type: 'source', tree_order: 20 }),
    page('c.md', 'Beta', { type: 'source' }),
    page('d.md', 'Aaa', { type: 'source' }),
  ];
  const idx = buildTreeIndex(pages);
  assert.deepEqual(idx.roots.map(p => p.basename), ['Zeta', 'Alpha', 'Aaa', 'Beta']);
});

test('buildTreeIndex puts dangling-parent elements in roots', () => {
  const pages = [page('x.md', 'Orphan', { type: 'source', parent: '[[Missing]]' })];
  const idx = buildTreeIndex(pages);
  assert.deepEqual(idx.roots.map(p => p.basename), ['Orphan']);
});

test('linkTargetName returns a bare (non-wikilink) string as-is — frontmatter may store a plain basename', () => {
  assert.equal(linkTargetName('Plain Name'), 'Plain Name');
  assert.equal(linkTargetName('[[Wiki]]'), 'Wiki');
  assert.equal(linkTargetName(''), null);
  assert.equal(linkTargetName(null), null);
});

const { wouldCreateCycle } = require('../tree-core.js');

test('wouldCreateCycle detects self, direct, and transitive cycles', () => {
  const page = (path, basename, fm) => ({ path, basename, fm });
  const idx = buildTreeIndex([
    page('a.md', 'A', { type: 'category' }),
    page('b.md', 'B', { type: 'category', parent: '[[A]]' }),
    page('c.md', 'C', { type: 'category', parent: '[[B]]' }),
  ]);
  assert.equal(wouldCreateCycle(idx, 'A', 'A'), true);   // self
  assert.equal(wouldCreateCycle(idx, 'A', 'B'), true);   // A under its child B
  assert.equal(wouldCreateCycle(idx, 'A', 'C'), true);   // A under descendant C
  assert.equal(wouldCreateCycle(idx, 'C', 'A'), false);  // C under ancestor A: fine
  assert.equal(wouldCreateCycle(idx, 'B', null), false); // move to root: fine
});

const { computeReorder } = require('../tree-core.js');

test('computeReorder renumbers with gap spacing, emits only changed', () => {
  const sibs = [
    { path: 'a.md', tree_order: 10 },
    { path: 'b.md', tree_order: 20 },
    { path: 'c.md', tree_order: 30 },
  ];
  // Move c.md (index 2) up to index 0 -> order c,a,b -> want 10,20,30.
  const writes = computeReorder(sibs, 'c.md', 0);
  const map = Object.fromEntries(writes.map(w => [w.path, w.tree_order]));
  assert.equal(map['c.md'], 10);
  assert.equal(map['a.md'], 20);
  assert.equal(map['b.md'], 30);
});

test('computeReorder assigns gaps when tree_order missing', () => {
  const sibs = [{ path: 'x.md' }, { path: 'y.md' }];
  const writes = computeReorder(sibs, 'y.md', 0);
  const map = Object.fromEntries(writes.map(w => [w.path, w.tree_order]));
  assert.equal(map['y.md'], 10);
  assert.equal(map['x.md'], 20);
});

test('computeReorder returns empty when movedPath absent', () => {
  assert.deepEqual(computeReorder([{ path: 'a.md', tree_order: 10 }], 'z.md', 0), []);
});
