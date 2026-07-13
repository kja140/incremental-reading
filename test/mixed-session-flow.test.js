'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('grade and advance consumes a reviewed card and continues the mixed session', () => {
  const method = main.match(/async gradeAndAdvance\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /await this\.consumeSessionItem\(active\.path\)/);
  assert.match(method, /await this\.nextElement\(\)/);
  assert.doesNotMatch(method, /reviewCardsInNote/);
});

test('opening a card does not consume it before the review is answered', () => {
  const method = main.match(/async openLearningItem\(item\) \{([\s\S]*?)\n  \}\n\n  async nextElement/)?.[1] || '';
  assert.match(method, /reviewCardsInNote/);
  assert.doesNotMatch(method, /consumeSessionItem/);
});
