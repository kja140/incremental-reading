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
// <<< topic-core-functions

module.exports = { progressAwareAFactor, hasProgressAdvanced };
