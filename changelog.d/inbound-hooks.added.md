- Webhook triggers: a trigger file with a `webhook` section (`verify: hmac | bearer | linear |
  slack`, `secret` naming a value in `secrets.yml`) takes signed deliveries at
  `POST /hooks/<root>/<trigger>` on a separate inbound listener, off by default and on loopback
  (`swarmupd.hooks`); give it a public URL through your own tunnel. Deliveries are checked,
  rate-limited, capped at 256 KB and deduped for 24 hours, and each one is logged in `hooks.log`.
- A delivery files a finding for triage with the payload fenced as untrusted text. It runs the
  trigger's action only where you set `swarmupd.hooks.direct.<root>.<trigger>: true`.
- `swarmup trigger fire <root>/<name>` does what a delivery does, and `swarmup trigger test
  <root>/<name> --payload FILE --sign` sends a signed payload through the local listener.
  `swarmup doctor` reports the listener and hook triggers whose secret is missing.
