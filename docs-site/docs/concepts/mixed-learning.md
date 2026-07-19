---
title: Mixed learning
---

# Mixed learning

The Toolkit deliberately keeps two kinds of scheduling separate:

- **Topics** (`source` and `extract`) are chosen and rescheduled by Incremental Reading Toolkit.
- **Cards** are Markdown notes tagged for the configured Spaced Repetition deck and reviewed by Spaced Repetition.

**Build today's session queue** alternates reading topics with card notes, giving one learning stream without pretending the underlying algorithms are the same. **Next element** opens the following saved path first. When it is a card, per-note Spaced Repetition review starts automatically and the accepted review finishes that queue entry. For a card-only session, use Spaced Repetition's own global review command.

This design also means your cards are not locked into a private format. The Toolkit writes native Spaced Repetition forms, including configured question/answer separators and cloze syntax.
