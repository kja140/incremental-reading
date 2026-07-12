'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nativeCardText, spacedRepetitionBody } = require('../spaced-repetition-core.js');

test('basic cards use the native multiline separator', () => {
  assert.equal(spacedRepetitionBody('basic', 'Question', 'Answer'), 'Question\n?\nAnswer\n');
});

test('bidirectional cards use the native bidirectional separator', () => {
  assert.equal(spacedRepetitionBody('reverse', 'Front', 'Back'), 'Front\n??\nBack\n');
});

test('card separators follow Spaced Repetition settings', () => {
  const settings = { multilineCardSeparator: ':::', multilineReversedCardSeparator: '<->' };
  assert.equal(spacedRepetitionBody('basic', 'Front', 'Back', settings), 'Front\n:::\nBack\n');
  assert.equal(spacedRepetitionBody('reverse', 'Front', 'Back', settings), 'Front\n<->\nBack\n');
});

test('cloze cards retain highlighted deletions without an answer separator', () => {
  assert.equal(spacedRepetitionBody('cloze', 'A ==cloze==', ''), 'A ==cloze==\n');
});

test('blank lines are normalized so they do not terminate multiline cards', () => {
  assert.equal(nativeCardText('one\n\ntwo'), 'one\n<br>\ntwo');
});
