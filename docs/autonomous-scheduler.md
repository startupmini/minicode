# Autonomous scheduler (experimental)

> **Experimental.** Opt-in per invocation, off by default, and manually triggered.
> There is no background timer. Nothing runs unless you ask it to.

The scheduler evaluates your task graph and, if a task is ready, hands it to an
autonomous MiniCode session that works on it without you.

## 1. Enable

Add the flag to any invocation:

```bash
minicode --enable-scheduler
```

That is the only way to turn it on. There is no config key, no environment
variable, and no way to inherit it from a parent process — a flag typed at the
command line is the whole mechanism. `--enable-scheduler=false` does **not**
enable it; the flag has no value form, and the bare flag is the only form that
counts.

On startup with the flag, the process acquires an exclusive lease on your session.
If another process already holds that lease, startup fails loudly rather than
starting a second scheduler over the same session.

## 2. Trigger

Scheduling is **manual**. Nothing runs on its own:

```text
/scheduler run
```

This performs exactly one scheduling cycle:

- re-read the task graph,
- select one ready task (if any),
- claim it durably,
- run one autonomous turn on it,
- report the outcome.

If nothing is ready, the cycle ends with `no task was ready` and no work is
created. If a task becomes ready *after* that, it stays pending until you run
`/scheduler run` again. There is no polling, no timer, and no background
recurrence — this is the current contract, not an oversight.

The command waits for the cycle to finish, then prints the result.

## 3. Observe

```text
/scheduler status
```

Reports the current state, the session it belongs to, whether the lease is held,
counters for this process, and the last five lifecycle events.

You will see one of five states:

| State | What it means |
| --- | --- |
| `scheduler OFF` | The flag was not passed. No scheduler exists. |
| `scheduler ON, idle` | Enabled, holds the lease, waiting for `/scheduler run`. |
| `scheduler ON, executing` | A cycle is in flight. |
| `scheduler ON but STOPPED` | Stopped, shut down, or its lease was lost. Will not schedule again in this process. |
| `scheduler ON, last cycle failed` | A cycle failed. The reason is on the next line. |

Lifecycle events also appear inline in the transcript as `[scheduler] ...` lines.
They are system entries, not conversation — they are never sent to the model and
never appear as tool output.

Activity is in-memory and resets when the process exits. Durable task state
survives; diagnostics do not.

## 4. Stop

```text
/scheduler stop
```

This prevents any further triggers, prevents new claims, cancels an autonomous
turn that is still running, and releases the session lease so another process can
take it.

Stopping twice is fine — the second call says so and does nothing.

Once stopped, a scheduler cannot be restarted. **Exit and start a new process**
with the flag to schedule again. There is no in-app toggle for the same reason
`/scheduler stop` is one-way: stopping a live turn is a shutdown, not a setting.

## 5. Recover

If a process dies while holding the lease, the lease is not released. The
replacement simply waits:

- lease duration is 5 minutes
- it is renewed every minute while the process is alive

So a crashed scheduler frees its session automatically within 5 minutes. To
recover immediately, delete the session (`/sessions`), which invalidates it
outright.

If the lease is lost while running (another process took over, or the session was
deleted), the scheduler **self-disposes**. It will not claim or execute anything
further, and the reason appears in `/scheduler status`. This is deliberate: a
scheduler that cannot prove it owns the session does nothing rather than
racing a process that can.

## 6. Disable

There is nothing to turn off. Remove the flag and the next process has no
scheduler at all — no lease, no store handle, no background resources. Stopping
the current one is `/scheduler stop`, or just exit.

## What the autonomous session may do

Autonomous turns run under a **read-only** policy. The tool set is a fixed
allow-list of read-only capabilities — file reads, search, git inspection, LSP
queries. Write, edit, execute and anything network-fetching is denied, and
nothing in the trigger path can widen it: the allow-list is enforced when the
executor is constructed, so a configuration that tried to widen it fails at
startup instead of running with more power.

Autonomous turns do not prompt for approval. There is no operator in the loop,
which is why the policy is narrow rather than permissive.

## Limitations

- One cycle per `/scheduler run`; no recurring scheduling.
- No approval step between claim and execution. The readonly policy is the
  boundary.
- Diagnostics are per-process and lost on exit.
- Two processes cannot schedule the same session at once; the second fails
  closed.
- Experimental. The interface may change.

## Related

- [cli.md](cli.md) — full flag reference
- [architecture.md](architecture.md) — where the scheduler sits
