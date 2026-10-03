# paytm-round-one-assignment

A seat-reservation service built to stay correct when thousands of people try to book the same few seats at once.

A seat is never sold twice, nobody can exceed their booking limit, retries do not create duplicate bookings, and expected declines return 4xx responses instead of server errors.

**Stack:** Node 24, Express 5, PostgreSQL (raw SQL through `pg`), `zod`, `jsonwebtoken`, `pino`, `prom-client`.

How and why it works: [WRITEUP.md](WRITEUP.md).

## Run it

```sh
docker compose up --build
```

The service starts on `http://localhost:3000` with its own PostgreSQL database.

It builds the image, starts PostgreSQL, runs the migrations and reports ready on:

```text
GET /readyz
```

Then, in another terminal:

```sh
./burst.sh http://127.0.0.1:3000
```

## The burst script

```sh
./burst.sh <BASE_URL>
```

or:

```sh
npm run burst -- <BASE_URL>
```

It needs only Node 18+.

The script creates a fresh show and sends around 20,000 booking requests.

| Phase | What it does |
|---|---|
| Hot-seat storm | 10 hot seats, 500 different people competing for each; some also send the same request again |
| Mixed traffic | 12,000 requests across 3,000 seats, including retries and concurrent requests |
| Identity checks | Requests attempt to spoof `user_id` in the body |
| Scenarios | Same key with a different request, unauthorized cancel, cancel and re-book, old cancel, multi-seat booking |

The script reports:

- Confirmed bookings
- Declines by reason
- 5xx responses
- Requests per second
- Safety checks

It verifies:

- No seat is sold twice
- Exactly one booking wins a hot-seat race
- Zero 5xx responses
- `available + held + confirmed == total`
- Retries return the original reservation
- Users cannot exceed their limit
- Identity always comes from the token
- The final show state matches client responses
- `/metrics` matches what the test observed

Exit code `0` means all checks passed.

Options:

```sh
./burst.sh <BASE_URL> --hot 10 --per-hot 500 --wide 12000 --concurrency 200
```

Set `ADMIN_KEY=...` if the server uses a different admin key.

For local testing, use `127.0.0.1` instead of `localhost`. On macOS, `localhost` can also resolve to IPv6, which can cause connection issues during a large connection storm.

### Smaller proof scripts

Each script focuses on one property:

```sh
npm run race
npm run retry
npm run limit
npm run multi
npm run cancel
```

- `race` — many users competing for one seat
- `retry` — concurrent requests using the same idempotency key
- `limit` — per-user booking limit
- `multi` — multi-seat requests and lock ordering
- `cancel` — cancellation safety

## Develop

Start only the database:

```sh
docker compose up -d db
```

The database is also available on `localhost:5432` for DBeaver or `psql`.

Install dependencies:

```sh
npm ci
```

Start the application:

```sh
npm run dev
```

Migrations run automatically at startup.

## API

Every error follows this format:

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}
```

Money values are represented as integer paise.

| Endpoint | Who | Notes |
|---|---|---|
| `POST /auth/token` `{"user_id":"alice"}` | Anyone | Stand-in for real authentication. Add `admin_key` for an admin token. |
| `POST /shows` `{name, seats:[...], price_paise, per_user_limit?=4}` | Admin | Creates the show and all seats in one transaction. |
| `GET /shows/:id` | Anyone | Returns per-seat status and counts. |
| `POST /shows/:id/reserve` `{"seats":["A12"]}` | User | Requires `Idempotency-Key`. Returns `201` for a new booking and `200` for an identical replay. |
| `POST /reservations/:id/cancel` | Owner | Frees the seats and returns the user's allowance. Repeated cancellation is harmless. |
| `GET /healthz` | Anyone | Liveness check. |
| `GET /readyz` | Anyone | Readiness check. Requires database connectivity and migrations. |
| `GET /metrics` | Anyone | Prometheus metrics. |
| `GET /me` | User | Returns the identity associated with the current token. |

The idempotency key can also be provided in the request body as `idempotency_key`.

Identity always comes from the token, never from the request body.

### Response codes

| Status | Codes |
|---|---|
| 400 | `idempotency_key_required`, `idempotency_key_mismatch`, `bad_request` |
| 401 / 403 | `unauthorized`, `forbidden` |
| 404 | `show_not_found`, `seat_not_found`, `reservation_not_found`, `not_found` |
| 409 | `seat_taken`, `per_user_limit`, `idempotency_key_reuse` |
| 413 | `payload_too_large` |
| 422 | `validation_error` |
| 429 | `overloaded` |
| 503 | `dependency_unavailable`, `starting_up` |

## Metrics and logs

`GET /metrics` exposes Prometheus metrics including:

- `reservations_confirmed_total`
- `reservations_declined_total{reason}`
- `reservations_cancelled_total`
- `seats_available{show_id}`
- `seats_held{show_id}`
- `seats_confirmed{show_id}`
- `http_requests_total`
- `http_request_duration_seconds`
- `db_pool_in_use`
- `db_pool_waiting`
- Process metrics

Decline reasons include:

- `seat_taken`
- `per_user_limit`
- `idempotent_replay`
- `idempotency_key_reuse`
- `seat_not_found`
- `show_not_found`
- `overloaded`

Seat gauges are counted directly from the database at scrape time.

Every booking request that reaches the service is counted exactly once as either confirmed or declined, allowing the metrics to be reconciled with client results.

Logs are JSON objects written to stdout.

Each request has a `req_id`. Clients can provide their own `X-Request-Id`; otherwise one is generated and returned in the response header.

Booking logs include an `outcome`, for example:

```text
confirmed
declined:seat_taken
```

Set:

```sh
LOG_LEVEL=warn
```

to reduce log volume.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATABASE_URL` | Local compose database | PostgreSQL connection string |
| `DATABASE_SSL` | `false` | Enable TLS for hosted databases |
| `DB_POOL_MAX` | `40` | Maximum database connections per process |
| `DB_POOL_WAIT_MS` | `10000` | Maximum time to wait for a database connection |
| `JWT_SECRET` | Dev value | **Required when `NODE_ENV=production`** |
| `ADMIN_KEY` | `demo-admin-key` | Key used to create admin tokens |
| `TOKEN_TTL_SECONDS` | `43200` | Token lifetime |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `silent` |

## Deploy

The service can be deployed to Render.

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. `render.yaml` creates the web service and PostgreSQL database.
4. The web service is built from the `Dockerfile`.
5. `/readyz` is used as the health check.
6. `DATABASE_URL` and `JWT_SECRET` are configured automatically.
7. Once deployed, verify:

```sh
curl https://<your-service>/readyz
```

8. Run the burst test:

```sh
./burst.sh https://<your-service>
```

9. Metrics are available at:

```text
https://<your-service>/metrics
```

Logs are available from the service's **Logs** tab in Render.

Free instances can sleep when idle and may take some time to wake up. They are also much slower than a local machine.

Some `429 overloaded` responses under heavy load are expected when resources are constrained. `5xx` responses are not.

## Layout

```text
src/
  server.js
  app.js
  config.js
  db.js
  migrate.js
  logger.js
  metrics.js
  errors.js
  schemas.js
  state.js

  middleware/
    request logging
    authentication
    validation
    readiness
    error handling

  routes/
    health
    auth
    shows
    reservations

  services/
    business rules
    transactions

  queries/
    SQL

migrations/
  numbered SQL migrations

scripts/
  burst.mjs
  race.mjs
  retry.mjs
  limit.mjs
  multi.mjs
  cancel.mjs
```
