'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { progressAwareAFactor, hasProgressAdvanced } = require('../topic-core.js');

const settings = { scheduling: {
  a_factor_min: 1.05,
  a_factor_max: 5,
  initial_af_base: 2.5,
  initial_af_slope: 0.25,
  initial_af_units_divisor: 10,
} };

test('progress-aware A-Factor uses the newly entered page', () => {
  const fm = { total_pages: 100, read_point: 10 };
  const oldValue = progressAwareAFactor(fm, settings);
  const newValue = progressAwareAFactor(fm, settings, { readPoint: 90 });
  assert.ok(newValue > oldValue);
});

test('chapter scheduling uses page_end instead of the whole book total', () => {
  const fm = { total_pages: 500, page_start: 200, page_end: 220, read_point: 210 };
  assert.equal(progressAwareAFactor(fm, settings), 2.5);
});

test('Markdown marker movement counts as progress for the stall guard', () => {
  assert.equal(hasProgressAdvanced({ previousLine: 10, nextLine: 25 }), true);
  assert.equal(hasProgressAdvanced({ previousLine: 25, nextLine: 25 }), false);
});
