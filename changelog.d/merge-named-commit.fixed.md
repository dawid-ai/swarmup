- swarmupd merges the commit the approved review names when the review writes it in code font or
  bold (`` `abc1234` on branch `x` ``). Before, such a review named no commit, so swarmupd took the
  branch of an earlier review; when that branch was empty, it recorded "already in main; nothing
  to merge" and unblocked the tasks that waited for the work. When the work it takes from an
  earlier or loose mention is already in the base and the approved review mentions a commit the
  base lacks, swarmupd now records no merge and files a finding linked from the task; the task and
  its dependants keep waiting. A commit id of digits only or letters only counts when it follows
  `commit`, `sha`, `hash` or `rev`, or is in code font or bold. A commit id in capitals
  (`023F19E`) counts in both places. A branch name in code font is read as written, underscores
  included (`` `__wip__` ``).
