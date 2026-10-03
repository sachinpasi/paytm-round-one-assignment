# Seat Reservation System — Write-up

## The atomic decision

Seat allocation happens inside **one PostgreSQL transaction** using a row lock:

```sql
BEGIN;

-- Claim idempotency key
INSERT INTO idempotency (...) ON CONFLICT DO NOTHING;

-- Enforce per-user limit
INSERT INTO user_holds (...)
ON CONFLICT DO UPDATE ...
WHERE seat_count + n <= limit;

-- Lock requested seats
SELECT seat_id, status
FROM seats
WHERE seat_id = ANY($seats)
ORDER BY seat_id
FOR UPDATE;

-- Validate, reserve and confirm seats

COMMIT;
```

`FOR UPDATE` serializes concurrent requests for the same seat. The first request books it; the next sees the latest committed state (`confirmed`) and returns 409.

A transaction alone is not enough because two requests can still read the same old state. The row lock is what prevents the race.

I also considered conditional updates, unique constraints and `SERIALIZABLE`, but row locks gave the simplest solution for multi-seat atomicity and deterministic locking.

A lock-free precheck rejects obviously unavailable seats before starting a transaction. It is only an optimization; the transaction remains the final decision.

## Multi-seat and deadlocks

Multi-seat booking is **all-or-nothing**.

Seats are always locked using `ORDER BY seat_id`, so requests for `[A1, A2]` and `[A2, A1]` acquire locks in the same order and cannot form a deadlock cycle.

## Per-user limit

A `user_holds` row tracks seats booked by each user for a show.

A conditional upsert enforces the limit atomically. Concurrent requests for the same user serialize on this row, so the limit cannot be exceeded.

The counter is part of the booking transaction, so failed bookings roll it back and cancellations return the allowance.

## Idempotency

Idempotency keys are stored with a unique `(user_id, key)` constraint in the same transaction as the reservation.

Concurrent duplicate requests therefore resolve to the same booking.

A request hash prevents reusing the same key for different seats, while failed transactions do not consume the key.

## Holds and cancellation

There are no timed holds. Reservations are confirmed immediately.

Cancellation locks the reservation, returns the user's allowance and frees only seats still belonging to that reservation.

## Consistency and database failure

The service uses a single primary PostgreSQL database and **fails closed** when the database is unavailable.

Booking returns 503 instead of using stale state. `/readyz` becomes unavailable so traffic can be stopped, while `/healthz` remains healthy so the process is not unnecessarily restarted.

## Observability

`/metrics` exposes:

* booking outcomes and decline reasons
* seat counts
* request count and latency
* database pool usage
* overloaded requests

Logs include a request ID and booking outcome.

I would monitor 5xx errors, readiness failures, pool pressure, reconciliation drift and high p99 latency.

## Overload handling

If a request waits longer than `DB_POOL_WAIT_MS` for a database connection, it returns **429 `overloaded`** with `Retry-After` instead of waiting indefinitely.

Startup only becomes ready after the database is reachable and migrations complete.

## Results

Local Docker testing produced:

* **4,000–6,000 requests/sec**
* **~110–190 ms p99**
* **0 5xx**
* **19/19 safety checks passed**

With a deliberately constrained database pool, excess traffic was shed with 429 while maintaining zero 5xx and passing the safety checks.

The same burst against the live deployment (https://paytm-round-one-assignment.onrender.com, Render free plan, Singapore, about 0.1 CPU):

* **19,792 requests, 200 at a time, in 155 seconds (about 127 requests/sec)**
* **p50 about 1.3 s, p99 about 5.2 s**
* **0 5xx and no failed requests**
* **19/19 safety checks passed**, including `/metrics` matching the client-side counts

The free instance is CPU-limited, so throughput is far lower than locally, but correctness and the zero-5xx behaviour held.

## AI usage

I used Claude Code as a development assistant to speed up implementation, explore approaches and handle repetitive coding.

The architecture and key technical decisions were mine, especially around transactions, concurrency, locking, idempotency, limits and failure handling.

For the critical paths, I validated the behavior myself through concurrent tests. I also deliberately removed the locking protection to reproduce the race condition and then verified the fix.

AI helped me implement faster, but I owned the design, reasoning, testing and final decisions.