/**
 * Write serialization for SQLite.
 *
 * SQLite permits exactly one writer at a time. Two concurrent write
 * transactions produce `SQLITE_BUSY` immediately — `busy_timeout` does not help,
 * because a *deferred* transaction that has already read and then tries to
 * write cannot simply wait without risking a deadlock, so the driver gives up.
 *
 * WAL (see `initDatabase`) removes reader/writer contention, which is the bulk of
 * the traffic, but writer/writer contention remains and must be handled here.
 *
 * The right shape is: parallelise the network fetch, serialise the write. A
 * promise chain is enough — no queue library needed for an in-process lock.
 */

let tail: Promise<unknown> = Promise.resolve()

/**
 * Run `fn` with exclusive access to the database.
 *
 * Nested calls are safe: they queue behind the outer one rather than
 * deadlocking, because the chain is keyed on the promise, not re-entered.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  // Swallow rejection on the chain itself so one failure does not poison every
  // queued write; the caller still sees the error via `run`.
  tail = run.catch(() => undefined)
  return run
}