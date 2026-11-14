- The desktop app shows a milestone's plan (step 4 of the milestone design). The inbox has a
  **Plans** group for plans that wait for approval, with each plan's item count and estimate
  sum. The task panel of a milestone shows the goal, `done_when` and the plan table with each
  item's task, owner, status, estimate and time spent; **Approve plan**, **Edit** and
  **Send back** while a plan waits; and the check history after. Edit mode changes a row's
  title, owner, estimate, `after`, `done_when`, reviewer, type and priority, and adds, removes
  and reorders rows; on a row that already has a task the fields that live in the task's file
  are read-only, and **Replace item** removes the item and adds it again under a new key.
- The board shows a milestone's progress on its card (`4/7 done, 9 h of 14 h`), and
  **Milestone** lanes group tasks by their `milestone:` label.
- swarmupd answers `GET /api/tasks/<id>/plan`, `POST /api/tasks/<id>/plan-approve` and
  `plan-reject`, and `GET /api/milestones`. They call the functions behind `swarmup plan show`,
  `approve` and `reject`, so the app and the CLI apply the same rules.
- A milestone that waits for its plan's tasks no longer shows in the inbox as a question to
  answer, and a plan change shows as one plan item instead of a message.
