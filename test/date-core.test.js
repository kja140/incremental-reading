'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseDateExact, parseDate, formatDate, reformatDate } = require('../date-core.js');

test('date formats parse and format without changing the calendar day', () => {
  const expected = new Date(2026, 6, 12);
  for (const [format, value] of [
    ['DD-MM-YYYY', '12-07-2026'],
    ['MM-DD-YYYY', '07-12-2026'],
    ['YYYY-MM-DD', '2026-07-12'],
  ]) {
    assert.equal(parseDateExact(value, format).getTime(), expected.getTime());
    assert.equal(formatDate(expected, format), value);
  }
});

test('invalid calendar dates are rejected instead of rolling into another month', () => {
  assert.equal(parseDateExact('31-02-2026', 'DD-MM-YYYY'), null);
  assert.equal(parseDateExact('02-31-2026', 'MM-DD-YYYY'), null);
});

test('stored legacy formats remain readable and can be migrated', () => {
  assert.equal(formatDate(parseDate('31-01-2026', 'YYYY-MM-DD'), 'YYYY-MM-DD'), '2026-01-31');
  assert.equal(reformatDate('31-01-2026', 'DD-MM-YYYY', 'MM-DD-YYYY'), '01-31-2026');
});
