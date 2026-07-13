'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function functionSource(name) {
  const match = main.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

test('Spaced Repetition scheduling comments control whether a card is due', () => {
  const factory = new Function(`${functionSource('spacedRepetitionCardIsDue')}; return spacedRepetitionCardIsDue;`);
  const isDue = factory();
  const today = new Date(2026, 6, 13);
  assert.equal(isDue('new card', today), true);
  assert.equal(isDue('<!--SR:!2026-07-12,2,250-->', today), true);
  assert.equal(isDue('<!--SR:!2026-07-13,2,250-->', today), true);
  assert.equal(isDue('<!--SR:!2026-07-14,2,250-->', today), false);
});

test('tree completion filtering does not force branches open', () => {
  assert.match(main, /this\._match = \{ keep, forceExpand: !!f \|\| this\.typeFilter !== 'all' \}/);
  assert.match(main, /const expanded = !!this\._match\?\.forceExpand \|\| this\.plugin\.isExpanded\(key\)/);
});

test('invalid clock components are rejected', () => {
  const factory = new Function(`${functionSource('parseTimeInput')}; return parseTimeInput;`);
  const parse = factory();
  assert.equal(parse('1:59'), 119);
  assert.equal(parse('1:60'), null);
  assert.equal(parse('2:59:59'), 10799);
  assert.equal(parse('2:60:00'), null);
  assert.equal(parse('2:00:60'), null);
});

test('extract creation distinguishes cancellation from an automatic interval', () => {
  assert.match(main, /if \(customStr === null\) return;/);
});

test('split book validates chapter ordering before creating files', () => {
  const start = main.indexOf('  async splitBook() {');
  const end = main.indexOf('\n// ============================================================================', start);
  const split = main.slice(start, end);
  assert.match(split, /if \(!lines\.length\)/);
  assert.match(split, /chapter\.end < chapter\.start/);
  assert.match(split, /chapter\.start <= previous\.end/);
  assert.match(split, /chapter\.end > totalPages/);
});
