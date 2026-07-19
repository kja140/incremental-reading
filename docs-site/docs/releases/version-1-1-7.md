---
title: "Version 1.1.7: the performance update"
description: Greatly faster note switching and grading, with the crash-prone refresh path removed.
slug: /releases/1.1.7
---

# Version 1.1.7: the performance update

Version 1.1.7 is a focused speed and stability release. Moving between notes and finishing a grade now
does far less work, particularly in larger vaults with Toolkit dashboards, queues, and knowledge-tree
views open.

The refresh path responsible for reported freezes and crashes is no longer part of note navigation.
The Toolkit opens the requested note first and defers the small amount of follow-up work that remains.

## What feels different

- **Switching notes is immediate.** The saved queue path opens before read-point positioning or card
  review begins.
- **Grading gets out of the way.** Session state is updated in memory and saved shortly afterward,
  preventing plugin-data writes from competing with the next note.
- **Background views stay quiet.** Inactive dashboards, queue timelines, and knowledge-tree tabs no
  longer render or perform forced layout checks during navigation.
- **Cards need fewer steps.** **Next element** opens a queued card directly in Spaced Repetition. Once
  the review is complete, the card is removed from the Toolkit session automatically.
- **The command palette is calmer.** Toolkit commands have been reduced from 38 to 9, with secondary
  actions collected into clear menus.

## The simplified daily loop

1. Run **Build today's session queue** once.
2. Run **Next element** to open the saved item.
3. For a reading topic, run **Grade current reading topic**. For a card, grade it in Spaced Repetition.
4. Run **Next element** again.

**Next element does not rebuild the queue or refresh the dashboard.** Queue construction remains an
explicit action, so navigation stays lightweight and predictable.

## Updating

Update to **1.1.7** through your plugin updater. For a manual installation, download `main.js`,
`manifest.json`, and `styles.css` from the
[GitHub release](https://github.com/kja140/incremental-reading/releases/tag/1.1.7), replace the existing
files in your plugin folder, then reload Obsidian.

No settings or note migration is required.
