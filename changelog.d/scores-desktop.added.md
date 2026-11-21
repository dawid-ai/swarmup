- The **Agents** view shows each agent's scores: per scorer the value, count, pass rate, pass or
  fail, a 30-day trend, what to change when it fails, and the worst tasks as links. **Reports**
  adds a trend per scorer, the worst tasks per scorer and what each scorer measures on hover.
- The **Runs** view shows the model, effort and definition stamp a run started with, a
  **resumed** badge with the run it resumed from, and its orientation (tool calls before the first
  edit). Filter the list to resumed runs or one model.
- `GET /api/scores/history` serves each agent's score trend; `GET /api/scores?task=` adds the
  orientation of the task's runs and a `scorers` list with each threshold and lever.
