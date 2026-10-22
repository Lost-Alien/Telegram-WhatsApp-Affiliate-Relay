# Architecture

The relay runs in one Node.js process. It owns a separate Telegram MTProto session, a WhatsApp linked-device identity, a SQLite database and a monitoring HTTP server. It has no runtime dependency on another bot or browser process.

## Message path

1. `Telegram` resolves the explicitly configured broadcast channels and subscribes to new-message events.
2. `snapshot()` stores text, hidden link destinations and small media descriptors. Large media buffers never enter the queue.
3. `Store.enqueue()` writes a durable outbox row keyed by Telegram channel/message ID. Duplicate IDs are ignored.
4. `Relay` takes one due job, converts links with at most two concurrent conversion tasks, and persists the converted text for retries.
5. If the post includes supported media, the Telegram client downloads it to a temporary file with one download worker.
6. `WhatsApp.send()` publishes to the configured newsletter using a stable message ID and waits for its matching server acknowledgement.
7. `Store` records delivery. The temporary media file is removed. Failures remain queued or visible as failed jobs.

The normal path starts when an event arrives; the worker does not deliberately delay healthy messages. A one-second timer wakes due retries and disconnected queues, while source reconciliation runs every 30 seconds.

## SQLite state

| Table | Responsibility |
| --- | --- |
| `settings` | Telegram session string and per-source recovery cursors |
| `auth` | WhatsApp credentials and Signal key material |
| `posts` | Outbox payloads, conversion results, stable IDs, attempts and outcomes |

The database uses WAL journaling with `synchronous=FULL`. WhatsApp key updates are committed transactionally before their promises resolve. Binary values use Baileys' buffer-aware serialization, with app-state sync keys restored to the expected protobuf type.

The outbox is bounded by a configurable count of pending and failed rows. Successful/skipped entries retain deduplication IDs for 30 days; the SQLite auth state is not pruned by that task. Sent payloads are cleared, while converted text and outcome metadata remain until pruning.

## Recovery boundaries

New sources start at their latest message. Existing sources resume from durable cursors and reconcile at most 100 newer messages per pass. Each cursor advances after its message is accepted or handled, so a full queue can be recovered after space becomes available.

An unavailable account prevents delivery without consuming job attempts. Conversion, download and acknowledgement failures use bounded exponential retry backoff. After eight failures, the job stays in the database for manual attention and retry.

A full queue during initial reconciliation must not mark an otherwise connected Telegram account unavailable: accepted jobs still need to drain. A dedicated regression test covers this behavior.

## Resource controls

- One delivery worker preserves a bounded number of active jobs.
- Two URL conversions may run concurrently per post.
- HTTP link responses are limited to 256 KiB and individual requests have deadlines.
- Media downloads use a single worker, disk files and a configured size bound.
- Full WhatsApp history is disabled; essential bootstrap and non-blocking identity data remain enabled.
- The example systemd service applies memory, swap, CPU and task limits to this relay only.

## Network and monitoring

Link expansion checks resolved addresses and pins the chosen address for the actual request. Private, loopback and metadata destinations are rejected; redirects are checked hop by hop. Merchant matching uses domain boundaries rather than substring matches.

The dashboard is intentionally password-free and binds to loopback by default in this public edition. It displays account pairing QR codes when needed. The Telegram two-step verification submission route accepts only local connections and does not store the submitted password.

## Delivery guarantee

The relay provides at-least-once delivery with durable local state and stable outbound message IDs. Exactly-once delivery is not guaranteed across a crash or ambiguous network acknowledgement. WhatsApp server acceptance also does not prove individual subscriber receipt or viewing.
