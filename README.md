# Incremental Reading Toolkit

Incremental reading for Obsidian. Read long sources a little at a time, extract the parts that matter, and turn extracts into flashcards from commands that work with PDFs, notes, and images.

Incremental Reading Toolkit schedules reading topics with an A-Factor and presents topics and card notes in one mixed learning stream. Flashcard scheduling and grading are delegated to the actively maintained [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) community plugin.

- **Topics** (`source`, `extract`) use the reading queue and A-Factor scheduling.
- **Cards** are native Spaced Repetition markdown in the `#flashcards/incremental-reading` deck.

> This plugin is desktop-only: its integrated reader can open vault PDFs and local external PDF paths using Electron/Node APIs that are unavailable on mobile.

## Inspiration

Incremental Reading Toolkit is inspired by [SuperMemo's incremental reading](https://help.supermemo.org/wiki/Incremental_reading) workflow and by bjsi's [Incremental Writing plugin for Obsidian](https://github.com/bjsi/incremental-writing). SuperMemo established the model of importing sources, revisiting them in prioritized portions, extracting important material, and turning it into durable question-and-answer knowledge. Incremental Writing demonstrated how prioritized, scheduled queues can feel native inside an Obsidian vault.

This is an independent Obsidian plugin and is not affiliated with or endorsed by SuperMemo or the Incremental Writing project. See [SuperMemo workflow alignment](docs/SUPERMEMO-ALIGNMENT.md) for a feature-by-feature comparison and the intentional differences.

## Features

- **Mixed learning queue** that alternates priority-aware topics with Spaced Repetition card notes.
- **Spaced Repetition integration** for card scheduling, review, and statistics.
- **A-Factor scheduling** for topics, optionally recomputed each pass from remaining pages/seconds.
- **Extracts** from selected text, the clipboard, or a PDF, linked back to their parent.
- **Flashcards** from clipboard text, images, and image occlusion.
- **Inline-card export** converts `Q:: … ::A::`, `{{c1::…}}`, and `==highlight==` forms into native Spaced Repetition card notes.
- **Knowledge tree** view of the source/extract hierarchy, with drag-to-reparent.
- **Reading queue** sidebar and a native main dashboard with session, workload, and collection-health statistics.
- **Integrated PDF reader** for vault and external PDFs, with page navigation and saved read points.

## Installation

### From the Community Plugins list

1. Open **Settings → Community plugins**.
2. Install and enable **Spaced Repetition**.
3. Browse, search for **Incremental Reading Toolkit**, install it, and enable it.

Card creation writes Spaced Repetition-compatible Markdown. Card review commands display an install reminder when Spaced Repetition is unavailable; topic scheduling remains available.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/kja140/incremental-reading/releases).
2. Copy them into `<vault>/.obsidian/plugins/incremental-reading-toolkit/`.
3. Install and enable **Spaced Repetition**, then reload Obsidian and enable Incremental Reading Toolkit.

## Quickstart

1. Open an article note and run **Incremental Reading Toolkit: Import clipping (active note)**, or create a source with **New source**.
2. Run **Next element**, read a useful portion, and create an extract from important selected text.
3. Leave the cursor where you stopped, then run **Grade and advance** to update the read point and schedule the next visit.
4. Create durable recall material with **Flashcard from clipboard**.
5. Continue with **Next element** to alternate topics and card notes, or run **Review cards (Spaced Repetition)** for a card-only session.

For recommended keybindings and step-by-step note, PDF, card, queue, and date workflows, see the [easy user guide](docs/USER-GUIDE.md).

The same quickstart is available without leaving Obsidian: run **Incremental Reading Toolkit: Open user guide**, or select **Open user guide** at the top of the plugin settings. The plugin's **Help** action opens this README directly instead of searching the Community Plugins directory.

When upgrading from a pre-release development build, run **Incremental Reading Toolkit: Migrate legacy cards to Spaced Repetition** once. The migration keeps card content and source links, adds the Spaced Repetition deck tag, and removes the legacy card-scheduling fields.

## Commands

Capture and create:

- **New source** — create a source note.
- **Import clipping (active note)** — turn the active note into a source.
- **Extract selection** / **Extract from clipboard (PDF-aware)** — make an extract.
- **Flashcard from clipboard** / **Flashcard: name this image** / **Image extract from clipboard** — make cards.
- **Occlusion: create cards from image** — image-occlusion cards.
- **Export inline cards to Spaced Repetition** — create native card notes from inline syntax.
- **Migrate legacy cards to Spaced Repetition** — convert pre-0.4 card notes.

Review:

- **Next element** / **Random due element** — pick a reading topic.
- **Grade and advance** / **End session (grade current)** — grade the current reading topic.
- **Review cards** / **Review cards in current note** — open Spaced Repetition's review UI.
- **Done** / **Dismiss** / **Postpone** / **Schedule (manual date)** — change an element's status.
- **Subset review** / **Mercy (spread overdue)** / **Postpone subtree** — bulk scheduling.

Organise and navigate:

- **Set priority** / **Boost priority**.
- **Open dashboard** / **Open reading queue sidebar** / **Open knowledge tree** (and sidebar).
- **New category** / **Move active element under…** — tree organisation.
- **Open parent** / **Open PDF (Toolkit viewer)**.
- **Toggle read-point** / **Jump to read-point** / **Add timeline checkpoint**.
- **Split article on H2 headings** / **Split book into chapters**.
- **Stats**.

## Settings

Settings are grouped by workflow and include plain-language descriptions for:

- reading intervals, progress awareness, and pace adjustments;
- reading queue display and ordering;
- inline-card parsing patterns;
- Spaced Repetition dependency status, deck tag, and card separators;
- knowledge-tree branch warnings;
- every plugin-managed vault path;
- date convention and diagnostic logging.

Use **Run setup check** at the top of the settings page to verify Spaced Repetition, folder separation, A-Factor bounds, and card separators. Each path setting also has a reset-to-default button. Configure card algorithms and review behaviour in Spaced Repetition itself.

## Privacy and permissions

Incremental Reading Toolkit is local-first and includes no telemetry, advertisements, account requirement, or update mechanism.

- **Clipboard:** Text and images are read only when you run a clipboard capture command.
- **Files outside the vault:** The integrated PDF view reads only the local PDF path stored in the active source's `pdf_path`. It does not modify the PDF. EPUB is not supported by the PDF viewer.
- **Network:** The plugin does not make network requests. YouTube source notes can contain a YouTube iframe; opening that embed lets Obsidian connect to YouTube to display the video.
- **Vault access:** File enumeration is scoped to the configured source, extract, card, category, attachment, and video folders. Source, extract, card, attachment, dashboard, and review-log files are created or updated only in the configured paths. Legacy-card and date-format migrations require explicit user actions.

## Development

```bash
npm install
npm run check
```

`main.js` is the shipped plugin. `tree-core.js` holds the pure, Obsidian-free tree logic that is unit-tested and inlined into `main.js`; a test guards that the two copies stay in sync.

See [RELEASING.md](RELEASING.md) for the release and Community directory submission checklist.

## License

[MIT](LICENSE)
