- A message sent in the PM chat as a turn starts or ends no longer waits for the app's round of
  reads: swarmupd answers queued reads one per turn of its event loop, so a write that arrives
  among them is answered at once (AO-0277).
