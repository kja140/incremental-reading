---
title: Troubleshooting
---

# Troubleshooting

## Cards do not open for review

Confirm Spaced Repetition is installed and enabled. Run **Run setup check**, then verify the deck tag and card separators match valid Spaced Repetition syntax.

## A topic does not appear

Check that it is a source or extract, is not done/dismissed, and is due. Also check configured folder paths and whether the current queue or subset excludes it.

## A PDF does not open

The integrated viewer is desktop-only and supports PDF, not EPUB. For an external file, verify the source’s local path still exists on this computer.

## The queue is overwhelming

Open **Advanced tools…** and use **Mercy (spread overdue)** to distribute the backlog. Use **Current element actions…** to dismiss or reprioritize low-value items.

## Parent/child structure looks wrong

Open the Knowledge Tree and reparent by dragging, or choose **Move active element under…** from **Advanced tools…**. Avoid manually editing managed frontmatter unless you are repairing a known field.

## Something changed after an upgrade

Check the project changelog and run the explicit migration command only if upgrading from a version that requires it. Migrations are not meant to be repeated casually.
