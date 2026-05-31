'use strict';
// Guard: main.js inlines tree-core.js's functions (Obsidian's loader can't resolve a
// relative require). The block between the `tree-core-functions` markers in main.js MUST
// stay byte-identical to the one in tree-core.js, or the tested logic and the shipped
// logic diverge silently. This test fails the moment they drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const START = '// >>> tree-core-functions';
const END = '// <<< tree-core-functions';

function extractBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  assert.ok(s !== -1, `${file} missing start marker ${START}`);
  assert.ok(e !== -1, `${file} missing end marker ${END}`);
  // Take everything after the start-marker line up to the end marker.
  const afterStart = src.indexOf('\n', s) + 1;
  return src.slice(afterStart, e).trim();
}

test('main.js inlined tree-core block is identical to tree-core.js', () => {
  assert.equal(extractBlock('main.js'), extractBlock('tree-core.js'));
});
