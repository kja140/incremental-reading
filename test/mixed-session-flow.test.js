'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('grade and advance consumes a reviewed card and continues the mixed session', () => {
  const method = main.match(/async gradeAndAdvance\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /this\.consumeSessionItem\(active\.path, \{ background: true \}\)/);
  assert.match(method, /await this\.nextElement\(\)/);
  assert.doesNotMatch(method, /reviewCardsInNote/);
});

test('opening a card does not consume it before the review is answered', () => {
  const method = main.match(/async openLearningItem\(item\) \{([\s\S]*?)\n  \}\n\n  async nextElement/)?.[1] || '';
  assert.match(method, /reviewCardsInNote/);
  assert.doesNotMatch(method, /consumeSessionItem/);
});

test('grade and advance does not continue when topic grading is cancelled', () => {
  const method = main.match(/async gradeAndAdvance\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /const graded = await this\.endSession\(\)/);
  assert.match(method, /if \(graded\) \{[\s\S]*?await this\.nextElement\(\)/);
});

test('grading keeps persistence off the navigation path and writes topic scheduling once', () => {
  const consume = main.match(/async consumeSessionItem\(path,[\s\S]*?\n  \}\n\n  async openLearningItem/)?.[0] || '';
  const grade = main.match(/async _gradeTopic\(file, fm, today\) \{([\s\S]*?)\n  \}\n\n  \/\/ Adaptive A-Factor/)?.[1] || '';
  assert.match(consume, /Promise\.all\(writes\)/);
  assert.match(consume, /if \(!background\) return persistence/);
  assert.equal((grade.match(/processFrontMatter\(file/g) || []).length, 1);
  assert.doesNotMatch(grade, /await this\.app\.vault\.append\(logFile/);
});

test('an empty current session is distinguished from a missing snapshot', () => {
  const method = main.match(/async nextElement\(\) \{([\s\S]*?)\n  \}\n\n  async randomDue/)?.[1] || '';
  assert.match(method, /if \(queue !== null\)/);
});

test('random due cards use the same Spaced Repetition handoff as session cards', () => {
  const method = main.match(/async randomDue\(\) \{([\s\S]*?)\n  \}\n\n  async gradeAndAdvance/)?.[1] || '';
  assert.match(method, /await this\.openLearningItem\(pick\)/);
});
