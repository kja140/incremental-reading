# Incremental Reading Toolkit changelog

## 1.0.2 — 2026-07-12

### Fixed
- Renamed the Community Plugins display name to **Incremental Reading Toolkit** because
  **Incremental Reading** is already published by another developer.

## 1.0.1 — 2026-07-12

### Fixed
- Changed the technical plugin ID to `incremental-reading-toolkit` because `incremental-reading` was
  already reserved in the Obsidian Community Plugins submission portal.
- Internal command dispatch now derives the command prefix from the manifest instead of hard-coding
  the plugin ID.

## 1.0.0 — 2026-07-12

### Changed
- **Renamed to Incremental Reading.** The release ID and folder name are now `incremental-reading`.
- Documented the project's inspiration from SuperMemo incremental reading and the Incremental Writing
  plugin, including a feature-by-feature alignment guide and the intentional scheduling differences.
- **Spaced Repetition powers card review.** Card review commands delegate to its Obsidian commands.
- New card notes use native Spaced Repetition markdown and the `#flashcards/incremental-reading` deck.
  Basic, bidirectional, cloze, image, inline-export, and image-occlusion paths are covered.
- Incremental Reading's queue and statistics now own sources/extracts only. Spaced Repetition owns all card
  scheduling, review history, and card statistics.
- Added **Migrate legacy cards to Spaced Repetition** for pre-0.4 card notes. Existing inline cards
  can be materialized with **Export inline cards to Spaced Repetition**.

### Fixed
- All editable source, extract, card, review-log, and Sioyek paths are now used at runtime. The
  unused daily-note setting was removed.
- Moving an extract or card to the knowledge-tree root now persists an explicit `tree_root: true`
  override instead of falling back to its `source` link.
- User-entered source titles and derived extract/card/chapter filenames are sanitized before vault
  creation. User-entered YAML string values are safely quoted.

## v0.3.0 — 2026-05-26

### New
- **Knowledge tree (SuperMemo "Contents window").** A navigable, editable hierarchy of every
  collection element, available as a main-pane tab (`Open knowledge tree`) and a sidebar dock
  (`Open knowledge tree (sidebar)`).
  - New `category` element type (`type: category`, files in `Categories/`) — container nodes that
    group material and are excluded from scheduling.
  - Tree edge = `parent` link, falling back to `source` for legacy extracts/cards (no migration).
  - Loose/uncategorized elements collect under a synthetic **Unfiled** node; dangling-parent
    elements show a ⚠ badge.
  - **Full editing:** create category, drag-drop reparent (cycle-guarded, cards rejected as drop
    targets), reorder siblings (`tree_order`, gap-spaced), rename (backlink-safe), dismiss.
  - Expand/collapse state persists to `data.json` (`tree.expanded`). Child-count badge warns above
    `tree.child_warn_threshold` (default 100).
- **Unit tests.** New `tree-core.js` (parent resolution, indexing, cycle detection, reorder math)
  with `node --test` coverage. Obsidian's plugin loader cannot resolve a relative `require`, so the
  tree logic is inlined into `main.js`; `test/inline-sync.test.js` enforces the inlined copy stays
  byte-identical to `tree-core.js`.

### Known limitations
- **Create-child-in-tree is deferred.** Categories are created in-tree; sources/extracts/cards are
  still created via the existing extract/flashcard/new-source commands, then placed by drag-drop.
- **Duplicate basenames collide.** The tree keys nodes by basename, so two IR files sharing a
  basename in different folders resolve to one node. Path-based resolution is a future follow-up.

## v0.2.1 — 2026-05-22

### Fixed
- **Sidebar queue order now matches the dashboard.** The sidebar reads `today_session_paths` from the dashboard frontmatter (or builds a fresh interleaved queue if no snapshot is present) and renders that as "Today's Session" — same order as the dashboard's "Today's Session" table. Items not in the session (overdue, new, active-no-due) appear in supplementary sections below.
- `fsrs.fuzz` toggle now applies ±5% jitter to the next interval.
- `queue.sidebar_enabled = false` now suppresses the sidebar (command shows a Notice and refuses to open).
- Inline-card review modal renders the card's own question/answer (or cloze-masked line) instead of the entire parent source body.
- Inline-card stable id no longer includes line number — edits to surrounding lines don't strand FSRS state.
- Sidebar `_render` is debounced (250 ms) on vault modify events to avoid thrash during heavy typing.

### Migration notes
- The inline-card id change (Patch 6 above) breaks existing inline-card FSRS state. The first `Seed inline cards` after the v0.2.1 upgrade may add duplicate entries with new ids; old entries with stale ids remain in frontmatter and can be cleaned up by hand. Future v0.2.2 will add a `prune-inline-cards` command.

### Bug-audit verification
v0.2.0's bug-audit commit (`779d8d7`) reported six items audited but only fixed `forget-card`. Re-confirming the other five as already-correct:
- `postpone-subtree`: traversal uses `walkSubtree` with a frontier queue, depth 6 — transitive extracts handled.
- `mercy`: spread weighted by `urgency` which dominates by priority — higher-priority items get smaller delays.
- `OcclusionModal`: `onClose` removes both stored `mousemove`/`mouseup` handlers.
- `gradeAndAdvance` on PDFs: `endSession` early-returns when the active file isn't markdown or fm isn't source/extract/card.
- `parseDMY` callers: every `new Date(...)` site uses no-arg or numeric input — no string from frontmatter bypasses regex validation.

## v0.2.0 — 2026-05-22

### New
- **Progress-aware A-Factor** for sources and extracts. The per-rep `a_factor` is recomputed from remaining pages or seconds, so long unfinished material stays in active rotation (small a_factor → short intervals) and short almost-done material exits quickly (large a_factor → growing intervals).
- **Stall guard**: interval cannot grow while `read_point` is unchanged between consecutive reps. Prevents books drifting into long intervals without progress.
- **FSRS-6 card scheduler**. Matches the canonical `open-spaced-repetition/ts-fsrs` v6 implementation: exponential initial difficulty `D0(G) = w4 - exp(w5*(G-1)) + 1`, linear-damped difficulty update with mean reversion toward `D0(Easy)`, personalized forgetting curve via `decay` (w20), independent hard (w15) and easy (w16) multipliers, same-day short-term stability path. 19-weight vector (w0..w18) replaces the old 17-weight FSRS-4.5 array.
- **Settings tab** covering Scheduling, FSRS, Queue, Inline cards, Paths, and Misc. All previously hard-coded constants are now editable from Obsidian's settings UI. Persists to `data.json` in the plugin directory.
- **Sidebar review queue** (`Open reading queue sidebar` command). Groups items into Overdue / Due Today / New / Active. Live filter input matches against tags or title substring. Configurable sort key (urgency / priority / due_date). Clicking a row opens the file and jumps to its read-point. Auto-refreshes on file modify + 30-second timer for midnight rollover.
- **Inline cards.** `Q:: ... ::A:: ...`, `{{c1::cloze}}`, and optional `==highlight==` forms parse out of source/extract bodies and surface in the sidebar's New / Due Today / Overdue sections. FSRS-6 state lives in the source file's `inline_cards[]` frontmatter array — no card files created. New `Seed inline cards from current file body` command scans the active file and appends new entries with `status: pending`. Click an inline card in the sidebar to grade it.
- **Timeline checkpoints.** New `Add timeline checkpoint` command (also accessible from an input box in the sidebar Timeline panel) appends to a `checkpoints[]` array in the source's frontmatter. Optional `Nd::` prefix overrides `next_review` to `today + N days`. Clicking a checkpoint in the sidebar scrolls the editor to the checkpoint's saved line.

### Changed
- Manifest version 0.1.2 → 0.2.0.
- `_bumpAFactor` no longer fires on postpone, advance, schedule-later, or schedule-earlier. The progress-aware recompute supersedes those signals. The extract-creation bump still fires (creating an extract is a discrete processing signal).
- `pickFromList` quality factors now read from settings (`quality_hold`, `quality_speed_up`, `quality_slow_down`) instead of hard-coded `[1.0, 0.95, 1.05]`.
- All A-Factor and FSRS helpers now take a context object (`ctx` for FSRS, `settings` for A-Factor) as first argument, so weight edits in the settings tab take effect on the next review without a plugin reload.

### Fixed
- `forget-card` now deletes the FSRS frontmatter fields (`stability`, `difficulty`, `last_grade`, `last_retrievability`, `review_count`) instead of setting them to `null`, and sets `next_review` based on the file's `priority` rather than always one day out.

### Known limitations
- Inline-card review modal currently displays the parent source body as the question/answer rather than the inline card's text. State persistence works correctly; UI follow-up planned for v0.2.1.
- Inline-card stable id includes line number, so editing surrounding lines strands existing FSRS state and re-seeding creates new entries. Follow-up: switch to literal-only hash or add a prune command.
- Sidebar does not auto-seed inline cards from source bodies on file modify (cost would be O(n) reads per render across 800+ sources). Use the `Seed inline cards from current file body` command per file.
