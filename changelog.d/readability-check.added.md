- A `readability` check scores the prose of Markdown files with the Flesch-Kincaid grade level:
  `{ check: readability, args: { path: 'posts/*.md', max_grade: 9 } }`, with `min_grade` for a
  floor. The formula and the syllable rule are pinned, so every machine gets the same grade. The
  desktop criteria builder has **Max grade** and **Min grade** fields for it.
