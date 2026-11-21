---
kind: module
summary: Repeating tasks; templates in repeats/ that create a task on a schedule or when another task closes
covers:
  - packages/core/src/repeats.ts
links: [workspace]
---

# Repeats

## Purpose

`swarmup repeat add` makes a task template that fires on a time rule (`once`, `daily`, `weekly`,
`weekdays`, `monthly`, `yearly`) or a condition (`closed T-1`, `children-closed T-1`).

## How it works

- A repeat is `repeats/<name>.md`: frontmatter with the rule, body for the task it creates.
- Each firing creates a task that names the repeat and the slot (`repeat_slot`) it fired for, so
  the store itself records what fired; nothing else is written.
- Slots keep their local time of day across daylight saving changes.
- swarmupd fires due repeats each tick (`Workspace.fireRepeats`) before it plans wakes, so a new
  task can start in the same tick; `swarmup repeat tick` does the same by hand.

## Invariants

- A paused swarmupd creates none; on resume each repeat fires once, for the latest slot it
  missed, not once per missed slot.
