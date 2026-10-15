# Run03 port-cleanup false block — 2026-10-15

## Evidence and cause

Original `sl-cold-rebuild-20261015-03/result.json` is retained as BLOCKED:
`cleanupFailures=["ports-not-closed"]`, while restoreStopped/sourceRetainedRunning
are true and compiled runtime exited0 with all required acceptance markers.
Observed service-ready was49.800094675s, total53.673046486s. This is one isolated
app/DB rebuild measurement on an existing engine, not whole-host recovery/SLA.

Same-context `independent-postcheck.json` found both127.0.0.1:3001/55433 refused
connections while bind returned EADDRINUSE. `socket-state-diagnosis.json` found
TIME_WAIT2 per port and no LISTEN. Owned PG exited/restart=no; source matched its
pinned identity and was running/healthy. No source-data before/after hash claim.

The final check reused full-recovery.free_port, whose bind tests whether an
address can be reserved. A closed TCP connection can remain in TIME_WAIT and
prevent bind even though no server is listening. Therefore bind failure was not
evidence of failed service shutdown. The cleanup code also short-circuited after
the first port failure and emitted reason=null for a cleanup-only failure.

## Prevention now implemented

- Before resource creation, keep strict bind: collision or address unavailability
  must block a new launch. Do not bypass it with SO_REUSEADDR or stop an unknown
  process. A subsequent launch can still legitimately fail if the address cannot
  yet be reserved; that is a preflight availability failure, not leaked service.
- After shutdown, require existing owned app cleanup and verified owned container
  exit, then bounded connection probes against the exact loopback endpoints.
  Only ECONNREFUSED counts as listener closure. A successful connection, timeout,
  socket exception or other network result fails closed. Do not infer cleanup
  solely from HTTP failure or from one refused connection without ownership checks.
- Probe both ports independently even when the first fails. Future result.json
  includes portClosure statuses and sanitized error categories/types; no raw
  exception values. Cleanup-only failure receives an explicit reason while
  cleanupFailures and stage preserve the rest of the execution evidence.
- Probes run inside the launcher execution context. Sandbox /proc observations
  are not interchangeable with live host networking. Independent diagnostics must
  use the same context; no second live run is needed to diagnose closure.
- No arbitrary sleep, TIME_WAIT flush, sysctl tuning, process killing or resource
  deletion. Never replay a consumed identity or rewrite its original result PASS.

ECONNREFUSED is a point-in-time endpoint observation. It does not promise that a
future bind succeeds or exclude an independently applied firewall REJECT rule.
Owned shutdown and exact resource identity remain separate mandatory checks;
unknown network behavior cannot be accepted as proof of shutdown.

## Verification and remaining limit

Offline lifecycle/port suite22/22 PASS; real no-install npm suite4/4 PASS.
The added lifecycle regression first failed because only3001 was probed; after
fix it verifies both ports, safe evidence and explicit cleanup failure. Other
cases cover TIME_WAIT/bind refusal, active listener, timeout return, socket
exception, unexpected network error and owned-stop failure despite closed ports.
Python AST and git diff --check PASS. No DB-backed Jest or migration invoked.

Commands:

```sh
python3 -B tools/dev/cold-rebuild.test.py
python3 -B tools/dev/cold-rebuild-npm.test.py
git diff --check
```

This is an offline-verified future-tool correction, not a new successful live
cleanup acceptance. Original03 evidence and prepared-source hashes remain
unchanged. A future drill requires a fresh identity, new prepared hashes and
precise authorization. Do not replay03.
