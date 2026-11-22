- A `page-contains` check fetches the published page after `swarmup published` and checks it
  holds every string of `contains` and none of `absent`:
  `{ check: page-contains, args: { from: published, contains: github.com/you/repo }, when: publish }`.
  It takes `url` for another page, waits 15 seconds at most, reads the first 2 MB, and is refused
  without `when: publish`.
