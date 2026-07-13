---
title: Notes and frontmatter
---

# Notes and frontmatter

Toolkit elements remain ordinary Markdown files. The plugin uses frontmatter to identify element type, parent relationships, scheduling state, priority, and source-specific progress such as PDF paths or read points.

A conceptual source looks like this:

```yaml
---
ir_type: source
ir_due: 2026-07-20
ir_priority: 50
ir_parent: Learning/Topics/Example
---
```

:::warning Conceptual example
Field names and values can evolve. Let the plugin create or migrate managed metadata instead of hand-authoring it from this simplified example. The authoritative behavior is the installed plugin version.
:::

Cards are different: the Toolkit writes Markdown compatible with Spaced Repetition, including the configured deck tag and separators. This is why card scheduling does not live in Toolkit-specific frontmatter.
