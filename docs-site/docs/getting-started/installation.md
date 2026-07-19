---
title: Installation and setup
sidebar_position: 3
---

# Installation and setup

## Community Plugins

1. In Obsidian, open **Settings → Community plugins**.
2. Install and enable **Spaced Repetition**.
3. Search for **Incremental Reading Toolkit**, install it, and enable it.
4. Open the Toolkit settings and run **Run setup check**.

## Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release. Place them in:

```text
<vault>/.obsidian/plugins/incremental-reading-toolkit/
```

Reload Obsidian, enable Spaced Repetition, then enable the Toolkit.

## Recommended first setup

Keep the default folders initially. Add convenient hotkeys for:

- **Next element**
- **Build today's session queue**
- **Grade current reading topic**
- **Extract selection**
- **Flashcard from clipboard**
- **Current element actions…**
- **Open Toolkit view…**

Configure the flashcard algorithm and card-review behavior in Spaced Repetition. Configure source/extract scheduling in the Toolkit.

:::caution Upgrading an early development build
Open **Advanced tools…** and run **Migrate legacy cards to Spaced Repetition** once. It preserves the card content and source links, adds the configured deck tag, and removes obsolete card-scheduling fields.
:::
