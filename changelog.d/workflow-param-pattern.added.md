- A workflow parameter can declare a `pattern`, a regular expression its whole value must match,
  such as `pattern: 'v[0-9.]+'`. A start refuses a value that misses it, and `swarmup validate`
  checks the pattern, the default and the options.
