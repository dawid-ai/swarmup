- Rubric scorers in `scorers/<id>.yaml` now run. The one machine that judges a store
  (`swarmupd.judge.scorers`: `true` for the roots it merges, or a list of roots; `scoring.runs_on`
  in `swarm.yaml` names it) has the LLM judge score a deterministic sample of the closed tasks each
  one applies to, blind by default, within `swarm.yaml` `scoring.daily_judge_tokens` per day (a
  machine may lower it with `swarmupd.judge.daily_tokens`). The scores show in `swarmup scores`
  like the built-in scorers', with the work's definition hash and variant.
- The definition hash now covers `rubrics/`, so a run's stamp names the rubrics it was judged by.
