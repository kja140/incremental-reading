# Incremental Reading

Incremental reading for Obsidian. Read long sources a little at a time, extract the parts that matter, and turn extracts into flashcards from commands that work with PDFs, notes, and images.

Incremental Reading schedules reading topics with an A-Factor. Flashcard scheduling and review are delegated to the actively maintained [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) community plugin.

- **Topics** (`source`, `extract`) use the reading queue and A-Factor scheduling.
- **Cards** are native Spaced Repetition markdown in the `#flashcards/incremental-reading` deck.

> This plugin is desktop-only: it integrates with the [Sioyek](https://sioyek.info/) PDF reader and uses Node APIs that are unavailable on mobile.

## Inspiration

Incremental Reading is inspired by [SuperMemo's incremental reading](https://help.supermemo.org/wiki/Incremental_reading) workflow and by bjsi's [Incremental Writing plugin for Obsidian](https://github.com/bjsi/incremental-writing). SuperMemo established the model of importing sources, revisiting them in prioritized portions, extracting important material, and turning it into durable question-and-answer knowledge. Incremental Writing demonstrated how prioritized, scheduled queues can feel native inside an Obsidian vault.

This is an independent Obsidian plugin and is not affiliated with or endorsed by SuperMemo or the Incremental Writing project. See [SuperMemo workflow alignment](docs/SUPERMEMO-ALIGNMENT.md) for a feature-by-feature comparison and the intentional differences.

## Features

- **Priority-aware topic queue** for incremental reading.
- **Spaced Repetition integration** for card scheduling, review, and statistics.
- **A-Factor scheduling** for topics, optionally recomputed each pass from remaining pages/seconds.
- **Extracts** from selected text, the clipboard, or a PDF, linked back to their parent.
- **Flashcards** from clipboard text, images, and image occlusion.
- **Inline-card export** converts `Q:: … ::A::`, `{{c1::…}}`, and `==highlight==` forms into native Spaced Repetition card notes.
- **Knowledge tree** view of the source/extract hierarchy, with drag-to-reparent.
- **Reading queue** sidebar and an optional Dashboard note showing today's session.
- **PDF-aware**: jump to a read-point, open the current source in Sioyek or the built-in viewer.

## Installation

### From the Community Plugins list

1. Open **Settings → Community plugins**.
2. Install and enable **Spaced Repetition**.
3. Browse, search for **Incremental Reading**, install it, and enable it.

Card creation writes Spaced Repetition-compatible Markdown. Card review commands display an install reminder when Spaced Repetition is unavailable; topic scheduling remains available.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/kja140/incremental-reading/releases).
2. Copy them into `<vault>/.obsidian/plugins/incremental-reading-toolkit/`.
3. Install and enable **Spaced Repetition**, then reload Obsidian and enable Incremental Reading.

## Getting started

1. Run **Incremental Reading: New source** to create a source note (or import a clipping into the active note).
2. While reading, select text and run **Incremental Reading: Extract selection** to make an extract.
3. Turn an extract into review material with **Incremental Reading: Flashcard from clipboard** or **Incremental Reading: Export inline cards to Spaced Repetition**.
4. Use **Incremental Reading: Next element** for reading topics and **Incremental Reading: Review cards (Spaced Repetition)** for cards.

When upgrading from a pre-release development build, run **Incremental Reading: Migrate legacy cards to Spaced Repetition** once. The migration keeps card content and source links, adds the Spaced Repetition deck tag, and removes the legacy card-scheduling fields.

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
- **Open parent** / **Open PDF (Obsidian viewer)** / **Open in Sioyek**.
- **Toggle read-point** / **Jump to read-point** / **Add timeline checkpoint**.
- **Split article on H2 headings** / **Split book into chapters**.
- **Stats**.

## Settings

A-Factor behaviour, queue display, inline-card parsing patterns, Spaced Repetition separators and deck tag, vault paths, and the Sioyek executable are configurable in Incremental Reading. Configure card algorithms and review behaviour in Spaced Repetition.

## Privacy and permissions

Incremental Reading is local-first and includes no telemetry, advertisements, account requirement, or update mechanism.

- **Clipboard:** Text and images are read only when you run a clipboard capture command.
- **Files outside the vault:** The optional Sioyek integration launches the configured local executable and can open a PDF or EPUB path stored in a source note. No other external files are read or modified.
- **Network:** The plugin does not make network requests. YouTube source notes can contain a YouTube iframe; opening that embed lets Obsidian connect to YouTube to display the video.
- **Vault changes:** Source, extract, card, attachment, dashboard, and review-log files are created or updated only in the configured vault paths. Legacy-card migration requires confirmation.

## Development

```bash
npm install
npm run check
```

`main.js` is the shipped plugin. `tree-core.js` holds the pure, Obsidian-free tree logic that is unit-tested and inlined into `main.js`; a test guards that the two copies stay in sync.

See [RELEASING.md](RELEASING.md) for the release and Community directory submission checklist.

## License

[MIT](LICENSE)
