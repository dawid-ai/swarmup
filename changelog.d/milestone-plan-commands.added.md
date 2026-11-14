- `swarmup plan propose | show | approve | reject | amend | apply` (step 2 of the milestone
  design). The holder of a milestone proposes its plan from a YAML file; one
  `swarmup plan approve` by a person creates a task per item with `parent`, `blocked_by`,
  `labels: [milestone:<id>]`, `plan_item`, `review` and `done_when`. `amend --kind subtask` and
  `--kind fix` add items at once, subtasks up to 25 % of the approved estimate;
  `amend --kind change` proposes the full revised plan, and its approval parks, blocks, unblocks
  or hands off the tasks it changes, one event per item. `swarmup plan apply` finishes an
  application that a crash left incomplete, and swarmupd runs it on its own.
- A task created from a plan keeps what the plan fixed: `handoff`, `assign` and `delegate` need an
  owner the plan allows and carry the task's waits; `park`, an early `unblock`, a `review --to`
  or `delegate --review` that differs from the plan's reviewer, and `done` by anyone but the
  reviewer its review named are refused. A person passes, and anyone else with `--force`,
  recorded. `reopen` brings a plan task back under the plan's owner and dependencies, and refuses
  an item the plan removed.
- Under `coordinated` sync the plan events are pushed at once, like claims and handoffs.
- swarmupd no longer routes a plan task to a role group when no agent answers to its owner: the
  task waits for the role its plan names.
