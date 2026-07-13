'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('tree actions stop pointer propagation and expose an explicit move action', () => {
  const method = main.match(/_attachActions\(row, page\) \{([\s\S]*?)\n  \}\n\}/)?.[1] || '';
  assert.match(method, /pointerdown/);
  assert.match(method, /reparentPath\(page\.path\)/);
  assert.match(method, /preventDefault/);
});

test('tree navigation uses a separate reusable content leaf', () => {
  const method = main.match(/async _openPage\(page\) \{([\s\S]*?)\n  \}\n\n  _attachDrag/)?.[1] || '';
  assert.match(method, /this\.contentLeaf/);
  assert.match(method, /getLeaf\('tab'\)/);
  assert.doesNotMatch(method, /getLeaf\(false\)/);
});

test('extract navigation does not call the source-only read-point command', () => {
  const method = main.match(/async _openPage\(page\) \{([\s\S]*?)\n  \}\n\n  _attachDrag/)?.[1] || '';
  assert.match(method, /page\.fm\.type === 'source'/);
  assert.doesNotMatch(method, /source' \|\| page\.fm\.type === 'extract/);
});
