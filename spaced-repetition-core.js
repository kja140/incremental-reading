'use strict';

// Pure markdown serialization shared with the shipped plugin.

// >>> spaced-repetition-core-functions
function nativeCardText(value) {
  return String(value ?? '').trim().replace(/\r/g, '').replace(/\n[ \t]*\n+/g, '\n<br>\n');
}

function spacedRepetitionBody(format, question, answer, settings = {}) {
  const q = nativeCardText(question);
  const a = nativeCardText(answer);
  if (format === 'cloze') return q + '\n';
  const separator = format === 'reverse'
    ? (settings.multilineReversedCardSeparator || '??')
    : (settings.multilineCardSeparator || '?');
  return `${q}\n${separator}\n${a}\n`;
}
// <<< spaced-repetition-core-functions

module.exports = { nativeCardText, spacedRepetitionBody };
