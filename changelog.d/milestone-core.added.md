- Core reads milestones and their plans (step 1 of the milestone design; no `swarmup plan` command
  yet). A task of type `milestone` needs exactly one `--done-when` line. The fold reads `plan`,
  `plan-approve`, `plan-amend` and `plan-reject` events into the effective plan, and a milestone
  with an approved plan stays `blocked` until every plan item has a task, every child is done or
  parked, and no done child still waits for its merge.
- `swarmup review` without `--to` and swarmupd read a reviewer from `review` in `task.md` after a
  delegation's reviewer; `--human` and the type or label route still come first.
