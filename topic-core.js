'use strict';

// >>> topic-core-functions
function progressAwareAFactor(fm, settings, overrides = {}) {
  const s = settings.scheduling;
  let remaining = null;
  const pageTarget = Number(fm.page_end) > 0 ? Number(fm.page_end) : Number(fm.total_pages);
  const readPoint = overrides.readPoint ?? fm.read_point;
  const readSeconds = overrides.readPointSeconds ?? fm.read_point_seconds;
  if (pageTarget > 0) {
    const read = Math.max(0, Math.min(Number(readPoint) || 0, pageTarget));
    remaining = Math.max(1, pageTarget - read);
  } else if (Number(fm.total_seconds) > 0) {
    const read = Math.max(0, Math.min(Number(readSeconds) || 0, Number(fm.total_seconds)));
    remaining = Math.max(1, (Number(fm.total_seconds) - read) / 60);
  }
  if (remaining == null) return null;
  const af = s.initial_af_base - s.initial_af_slope * Math.log2(remaining / s.initial_af_units_divisor);
  return Math.max(s.a_factor_min, Math.min(s.a_factor_max, af));
}

function hasProgressAdvanced({
  previousPage = 0,
  nextPage = 0,
  previousSeconds = 0,
  nextSeconds = 0,
  previousLine = 0,
  nextLine = 0,
} = {}) {
  return Number(nextPage) > Number(previousPage)
    || Number(nextSeconds) > Number(previousSeconds)
    || Number(nextLine) > Number(previousLine);
}

// Merge independently ranked topics and cards without allowing one type to
// monopolise the session. This mirrors SuperMemo's mixed topic/item stream
// while leaving each scheduler responsible for ranking its own material.
function interleaveLearningItems(items, score = () => 0) {
  const ranked = items.slice().sort((a, b) => score(b) - score(a));
  const topics = ranked.filter(item => item.fm?.type !== 'card');
  const cards = ranked.filter(item => item.fm?.type === 'card');
  if (!topics.length || !cards.length) return ranked;
  const out = [];
  let next = score(cards[0]) > score(topics[0]) ? 'card' : 'topic';
  while (topics.length || cards.length) {
    const primary = next === 'card' ? cards : topics;
    const fallback = next === 'card' ? topics : cards;
    out.push((primary.length ? primary : fallback).shift());
    next = next === 'card' ? 'topic' : 'card';
  }
  return out;
}
// <<< topic-core-functions

module.exports = { progressAwareAFactor, hasProgressAdvanced, interleaveLearningItems };
