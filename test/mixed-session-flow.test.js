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

test('grading consumes the current item without navigating', () => {
  const method = main.match(/async gradeCurrent\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /this\.consumeSessionItem\(active\.path, \{ background: true \}\)/);
  assert.doesNotMatch(method, /nextElement/);
  assert.doesNotMatch(method, /reviewCardsInNote/);
});

test('opening a card does not consume it before the review is answered', () => {
  const method = main.match(/async openLearningItem\(item\) \{([\s\S]*?)\n  \}\n\n  async buildSessionQueue/)?.[1] || '';
  assert.match(method, /reviewCardsInNote/);
  assert.doesNotMatch(method, /consumeSessionItem/);
});

test('grade current does not consume a topic when grading is cancelled', () => {
  const method = main.match(/async gradeCurrent\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /const graded = await this\.endSession\(\)/);
  assert.match(method, /if \(graded\) \{[\s\S]*?consumeSessionItem/);
});

test('grading keeps persistence off the navigation path and writes topic scheduling once', () => {
  const consume = main.match(/async consumeSessionItem\(path,[\s\S]*?\n  \}\n\n  async openLearningItem/)?.[0] || '';
  const grade = main.match(/async _gradeTopic\(file, fm, today\) \{([\s\S]*?)\n  \}\n\n  \/\/ Adaptive A-Factor/)?.[1] || '';
  assert.match(consume, /const persistence = this\.saveSettings\(\)/);
  assert.match(consume, /if \(!background\) return persistence/);
  assert.doesNotMatch(consume, /processFrontMatter|dashboardPath/);
  assert.equal((grade.match(/processFrontMatter\(file/g) || []).length, 1);
  assert.doesNotMatch(grade, /await this\.app\.vault\.append\(logFile/);
});

test('next element is a direct saved-path open with no refresh work', () => {
  const method = main.match(/async nextElement\(\{ fromStart = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  async randomDue/)?.[1] || '';
  assert.match(method, /this\.settings\.session/);
  assert.match(method, /getAbstractFileByPath/);
  assert.match(method, /getLeaf\(false\)\.openFile\(next\)/);
  assert.match(method, /this\.directQueueNavigation = true/);
  assert.match(method, /this\.directQueueNavigationDepth\+\+/);
  assert.match(method, /this\.directQueueNavigationDepth > 0/);
  assert.doesNotMatch(method, /readSessionSnapshot|buildDuePool|persistSessionSnapshot|openLearningItem|getFm/);
});

test('session queue construction is explicit and separate from navigation', () => {
  const method = main.match(/async buildSessionQueue\([\s\S]*?\n  \}\n\n  async nextElement/)?.[0] || '';
  assert.match(method, /buildDuePool/);
  assert.match(method, /persistSessionSnapshot/);
  assert.match(method, /nextElement\(\{ fromStart: true \}\)/);
  assert.match(main, /cmd\('build-session-queue',\s*'Build today\\'s session queue'/);
  assert.doesNotMatch(main, /cmd\('grade-and-advance'/);
});

test('session start retains the first item even when it is already active', () => {
  const factory = new Function(`${functionSource('savedQueueCandidates')}; return savedQueueCandidates;`);
  const candidates = factory();
  assert.deepEqual(candidates(['first.md', 'second.md'], 'first.md', true), ['first.md', 'second.md']);
  assert.deepEqual(candidates(['first.md', 'second.md'], 'first.md', false), ['second.md']);
});

test('card completion requires a verified Spaced Repetition scheduling change', () => {
  const method = main.match(/async gradeCurrent\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ ---- End Session/)?.[1] || '';
  assert.match(method, /this\.completedSpacedRepetitionReviews\.get\(active\.path\)/);
  assert.match(method, /Review and answer this card in Spaced Repetition before grading it/);
  assert.match(main, /spacedRepetitionScheduleSignature\(content\)/);
});

test('random due cards use the same Spaced Repetition handoff as session cards', () => {
  const method = main.match(/async randomDue\(\) \{([\s\S]*?)\n  \}\n\n  async gradeCurrent/)?.[1] || '';
  assert.match(method, /await this\.openLearningItem\(pick\)/);
});

test('completed single-note card review closes the Spaced Repetition deck menu', () => {
  assert.match(main, /SPACED_REPETITION_TAB_VIEW = 'spaced-repetition-tab-view'/);
  assert.match(main, /pendingSpacedRepetitionReview/);
  assert.match(main, /\.sr-deck-container:not\(\.sr-is-hidden\)/);
  assert.match(main, /getLeavesOfType\(SPACED_REPETITION_TAB_VIEW\)/);
  assert.match(main, /leaf\.detach\(\)/);
  assert.match(main, /modal-close-button/);
});
