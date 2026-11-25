- A workflow parameter that fills the command of a `command` check can no longer change that
  command: `swarmup workflow start` and the app's **Start a workflow** refuse a value with
  anything but letters, digits and `. _ / : @ -` in it, or one that starts with `-`. Titles and
  bodies still take any value. The app says which parameters go into a command and why a value
  is refused before you press **Start**.
- `swarmup validate` refuses a workflow whose parameter is the program a command runs (unless it
  lists `options`), and a default or an option that cannot go into the command it fills.
