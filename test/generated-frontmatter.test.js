'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('generated top-level frontmatter keys are not accidentally indented', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const key of ['source', 'parent', 'pdf_path', 'sioyek_path']) {
    assert.doesNotMatch(source, new RegExp(`^ {2,}${key}:`, 'm'));
  }
});
