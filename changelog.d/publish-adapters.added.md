- Publish adapters: define `swarmupd.publish.<root>.<name>` (`manual`, `command` or `mcp`), give a
  publish task the label `publish:<name>`, and run `swarmup publish ID` or **Publish** in the task
  panel. The adapter gets the approved files, runs once for the same files and blobs unless
  `--again`, and the `url: <URL>` it prints becomes the publish record. A `command` adapter gets
  the files and `SWARMUP_PUBLISH_*` variables; an `mcp` adapter calls a tool on a `publish: true`
  MCP server. Agents and runs can never start one.
