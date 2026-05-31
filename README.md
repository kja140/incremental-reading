# IR Toolkit

Incremental reading and spaced repetition for Obsidian. Read long sources a little at a time, extract the parts that matter, turn extracts into flashcards, and let the scheduler decide what to review next — all from commands that work whether you're looking at a PDF, a note, or an image.

IR Toolkit follows the SuperMemo model of a single interleaved queue containing two kinds of element:

- **Topics** (`source`, `extract`) — scheduled with an A-Factor (intervals grow each pass; long unfinished material stays in rotation).
- **Items** (`card`) — scheduled with **FSRS-6** (graded Again / Hard / Good / Easy).

> This plugin is desktop-only: it integrates with the [Sioyek](https://sioyek.info/) PDF reader and uses Node APIs that are unavailable on mobile.

## Features

- **One interleaved queue** of topics and cards, ordered by a priority-dominant urgency score with a configurable cards-per-topic ratio.
- **FSRS-6 scheduling** for cards (per-card stability, difficulty, and learnable decay).
- **A-Factor scheduling** for topics, optionally recomputed each pass from remaining pages/seconds.
- **Extracts** from selected text, the clipboard, or a PDF, linked back to their parent.
- **Flashcards** from clipboard text, images, and image occlusion.
- **Inline cards** parsed straight out of a note body (`Q:: … ::A::`, `{{c1::…}}`, and `==highlight==` cloze), each carrying its own FSRS state.
- **Knowledge tree** view of the source/extract hierarchy, with drag-to-reparent.
- **IR queue** sidebar and a Dashboard note (Dataview) showing today's session.
- **PDF-aware**: jump to a read-point, open the current source in Sioyek or the built-in viewer.

## Installation

### From the Community Plugins list

1. Open **Settings → Community plugins**.
2. Browse, search for **IR Toolkit**, and install.
3. Enable the plugin.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/kja140/incremental-reading/releases).
2. Copy them into `<vault>/.obsidian/plugins/ir-toolkit/`.
3. Reload Obsidian and enable the plugin under **Community plugins**.

## Getting started

1. Run **IR: New source** to create a source note (or import a clipping into the active note).
2. While reading, select text and run **IR: Extract selection** to make an extract.
3. Turn an extract into review material with **IR: Flashcard from clipboard** or **IR: Seed inline cards from current file body**.
4. Run **IR: Next element** to start a session, then **IR: Grade and advance** to grade the current element and move on.

## Commands

Capture and create:

- **New source** — create a source note.
- **Import clipping (active note)** — turn the active note into a source.
- **Extract selection** / **Extract from clipboard (PDF-aware)** — make an extract.
- **Flashcard from clipboard** / **Flashcard: name this image** / **Image extract from clipboard** — make cards.
- **Occlusion: create cards from image** — image-occlusion cards.
- **Seed inline cards from current file body** — parse inline cards out of a note.

Review:

- **Next element** / **Random due element** — pick what to review.
- **Grade and advance** / **End session (grade current)** — grade the current element.
- **Done** / **Dismiss** / **Postpone** / **Schedule (manual date)** — change an element's status.
- **Forget card (reset FSRS)** — reset a card's scheduling state.
- **Subset review** / **Mercy (spread overdue)** / **Postpone subtree** — bulk scheduling.

Organise and navigate:

- **Set priority** / **Boost priority**.
- **Open dashboard** / **Open IR queue sidebar** / **Open knowledge tree** (and sidebar).
- **New category** / **Move active element under…** — tree organisation.
- **Open parent** / **Open PDF (Obsidian viewer)** / **Open in Sioyek**.
- **Toggle read-point** / **Jump to read-point** / **Add timeline checkpoint**.
- **Split article on H2 headings** / **Split book into chapters**.
- **Stats**.

## Settings

Scheduling weights and behaviour are configurable in the plugin's settings tab, including FSRS-6 weights (`w0`–`w20`), request retention, fuzz, A-Factor bounds, the cards-per-topic ratio, and inline-card parsing patterns.

## Development

```bash
npm test    # runs the unit tests under test/ with node:test
```

`main.js` is the shipped plugin. `tree-core.js` holds the pure, Obsidian-free tree logic that is unit-tested and inlined into `main.js`; a test guards that the two copies stay in sync.

## License

[MIT](LICENSE)
