---
id: human:owner
name: Owner
---

# Owner

You review work, answer asks, and decide anything that touches accounts or money.

- **Inbox.** Run `swarmup inbox` to see what waits on you: messages sent to you with `--to`, asks,
  reviews, and tasks you own. Run `swarmup inbox --mark-read` when you have read them.
- **Asks.** Agents stop with `swarmup ask` when they need you. Answer with `swarmup answer <ID> "<answer>"`;
  the task goes back to `todo` and the answer reaches whoever asked.
- **Reviews.** Reviews come to you unless the author names an agent reviewer. Close the task with
  `swarmup verdict <ID> approve "<note>"`, or send it back with `swarmup verdict <ID> changes "<what>"`.
- **Housekeeping.** You may act on any task, including `swarmup assign`, `swarmup priority` and `swarmup park`.
