---
title: Spaced Repetition integration
---

# Spaced Repetition integration

Incremental Reading Toolkit expects the actively maintained **Spaced Repetition** community plugin for card review.

When you create a card, the Toolkit:

1. writes a Markdown card in the configured cards folder;
2. applies the configured incremental-reading deck tag;
3. uses the configured question/answer or cloze form;
4. preserves a link back to the relevant source where applicable.

Spaced Repetition then owns card scheduling, grading, review UI, and card statistics. If it is unavailable, topic scheduling still works and card-review commands show an installation reminder.

This integration is intentionally one-way at the algorithm boundary: the Toolkit prepares compatible cards; it does not duplicate Spaced Repetition’s scheduler.
