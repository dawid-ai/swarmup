- The PM checks asks, plans and new decisions against the decision log. Before it answers an
  ask, it compares the answer with the decisions in force for the task and forwards a conflict
  to the person as `contradiction with D-NNNN (date): <line>` with `keep` and `change` options
  and a recommendation. swarmupd starts one PM run at most once per `plan_check_minutes`
  (default 30; `0` turns it off) with the new `swarmup start` plans and checkpoint `--next`
  steps and the decisions in force for their tasks. A decision a person records shows in the
  PM's inbox as a `record` item, so a conflict the record does not name gets a comment to that
  person. The starter roles gain a PM role file, `claude-pm.md`.
