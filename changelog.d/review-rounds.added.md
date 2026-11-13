- swarmupd stops a review loop: after `review_rounds` `changes` verdicts on a task in a row
  (default 3; `0` turns it off), it blocks the task for the PM with the text of those verdicts
  instead of waking the author for another round.
