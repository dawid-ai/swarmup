- A Codex PM can answer release questions: its sandbox has no network, so `gh release list` failed
  there. swarmupd now reads each code checkout's GitHub releases and local tags itself, at most
  every 10 minutes, and puts them in the prompt of every `codex:pm` run.
