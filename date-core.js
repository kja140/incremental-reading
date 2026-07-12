'use strict';

// >>> date-core-functions
const SUPPORTED_DATE_FORMATS = ['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'];

function normalizeDateFormat(format) {
  return SUPPORTED_DATE_FORMATS.includes(format) ? format : 'DD-MM-YYYY';
}

function parseDateExact(value, format = 'DD-MM-YYYY') {
  if (!value) return null;
  const normalized = normalizeDateFormat(format);
  const match = String(value).trim().match(/^(\d{2}|\d{4})-(\d{2})-(\d{2}|\d{4})$/);
  if (!match) return null;
  const parts = String(value).trim().split('-').map(Number);
  let day, month, year;
  if (normalized === 'DD-MM-YYYY') [day, month, year] = parts;
  else if (normalized === 'MM-DD-YYYY') [month, day, year] = parts;
  else [year, month, day] = parts;
  if (year < 1000 || day < 1 || month < 1 || month > 12) return null;
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function parseDate(value, preferredFormat = 'DD-MM-YYYY') {
  const preferred = normalizeDateFormat(preferredFormat);
  for (const format of [preferred, ...SUPPORTED_DATE_FORMATS.filter(f => f !== preferred)]) {
    const parsed = parseDateExact(value, format);
    if (parsed) return parsed;
  }
  return null;
}

function formatDate(date, format = 'DD-MM-YYYY') {
  const normalized = normalizeDateFormat(format);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).padStart(4, '0');
  if (normalized === 'MM-DD-YYYY') return `${month}-${day}-${year}`;
  if (normalized === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
  return `${day}-${month}-${year}`;
}

function reformatDate(value, fromFormat, toFormat) {
  const parsed = parseDateExact(value, fromFormat);
  return parsed ? formatDate(parsed, toFormat) : value;
}
// <<< date-core-functions

module.exports = {
  SUPPORTED_DATE_FORMATS,
  normalizeDateFormat,
  parseDateExact,
  parseDate,
  formatDate,
  reformatDate,
};
