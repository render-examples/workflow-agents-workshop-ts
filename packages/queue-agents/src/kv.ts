/**
 * Valkey (Redis-compatible) plumbing — local to queue-agents (the only one that
 * needs a queue).
 *
 *   - a work queue on a Valkey Stream (XADD / XREADGROUP / XACK)
 *   - live progress over pub/sub (PUBLISH / SUBSCRIBE)
 *
 * This is exactly the coordination layer that Render Workflows makes disappear
 * in workflow-agents — here you own the stream, the consumer group, and the acks.
 */
import { Redis } from 'ioredis'

export const STREAM = 'reviews:queue'
export const GROUP = 'reviewers'

/**
 * How long a delivered-but-un-acked entry must sit idle before another consumer
 * may reclaim it. This is what turns "leave it un-acked" into an actual retry:
 * `XREADGROUP >` only ever delivers *new* messages, so a failed entry would stay
 * pending forever without a reclaim pass.
 */
export const RECLAIM_IDLE_MS = 30_000

export interface ReviewJob {
  reviewId: string
  prUrl: string
}

function url(): string {
  return process.env.VALKEY_URL?.trim() || 'redis://127.0.0.1:6379'
}

let _client: Redis | undefined

/** Shared connection for non-blocking commands (XADD, PUBLISH). */
export function getValkey(): Redis {
  if (!_client) _client = new Redis(url(), { maxRetriesPerRequest: null })
  return _client
}

/** Disconnect the shared client (for graceful shutdown and test cleanup). */
export async function closeValkey(): Promise<void> {
  if (_client) {
    _client.disconnect()
    _client = undefined
  }
}

// ── Queue ────────────────────────────────────────────────────────────────────

export async function enqueueReview(job: ReviewJob): Promise<void> {
  await getValkey().xadd(STREAM, '*', 'reviewId', job.reviewId, 'prUrl', job.prUrl)
}

export async function ensureGroup(client: Redis): Promise<void> {
  try {
    await client.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM')
  } catch (err) {
    // BUSYGROUP = group already exists; anything else is real.
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err
  }
}

/**
 * Handle one delivered stream entry: run the handler, then decide whether to
 * acknowledge the message.
 *
 *   - On success → XACK so the consumer group never redelivers it.
 *   - On failure → don't ack; log and return so the message stays pending
 *     for retry. The error must not escape — that would kill the consumer loop.
 */
export async function processEntry(
  client: Redis,
  id: string,
  fields: string[],
  handler: (job: ReviewJob) => Promise<void>,
): Promise<void> {
  try {
    const job = fieldsToJob(fields)
    if (job) await handler(job)
    // Success (or an unparseable entry we can't retry) → ack so the group never
    // redelivers it.
    await client.xack(STREAM, GROUP, id)
  } catch (err) {
    // Failure → leave the entry un-acked in the group's pending list so it can be
    // retried later. Swallow the error so the consumer loop keeps running.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[queue-agents:worker] entry ${id} failed (left un-acked for retry):`, message)
  }
}

export interface ConsumeOptions {
  consumerName?: string
  signal?: AbortSignal
  /** Override the idle threshold before a pending entry is reclaimed (ms). */
  reclaimIdleMs?: number
}

export interface ReclaimOptions {
  consumerName?: string
  /** Minimum idle time (ms) before an entry is eligible to be reclaimed. */
  minIdleMs?: number
  /** Max entries to reclaim per call. */
  count?: number
}

/**
 * Reclaim entries that were delivered to some consumer but never acked (a handler
 * crashed, a worker died) and re-run them through `processEntry`. This is the
 * other half of at-least-once delivery: `processEntry` decides *whether* to ack;
 * this is what actually re-delivers an entry that wasn't. Returns how many
 * entries were reclaimed and re-processed.
 */
export async function reclaimStale(
  client: Redis,
  handler: (job: ReviewJob) => Promise<void>,
  options: ReclaimOptions = {},
): Promise<number> {
  const consumer = options.consumerName ?? `worker-${process.pid}`
  const minIdle = options.minIdleMs ?? RECLAIM_IDLE_MS
  const count = options.count ?? 10

  // XAUTOCLAIM atomically finds pending entries idle longer than
  // minIdle and transfers ownership to `consumer`, returning them to us.
  const res = (await client.xautoclaim(STREAM, GROUP, consumer, minIdle, '0', 'COUNT', count)) as
    | [string, Array<[string, string[]]>, string[]]
    | null

  const entries = res?.[1] ?? []
  for (const [id, fields] of entries) {
    await processEntry(client, id, fields, handler)
  }
  return entries.length
}

/**
 * Blocking consumer loop. Reads one job at a time and hands each delivered entry
 * to `processEntry`, which runs the handler and acks on success.
 */
export async function consumeReviews(
  handler: (job: ReviewJob) => Promise<void>,
  options: ConsumeOptions = {},
): Promise<void> {
  const consumer = options.consumerName ?? `worker-${process.pid}`
  const reclaimIdleMs = options.reclaimIdleMs ?? RECLAIM_IDLE_MS
  const client = new Redis(url(), { maxRetriesPerRequest: null })
  await ensureGroup(client)

  while (!options.signal?.aborted) {
    // First reclaim anything a previous run failed on and left pending, then read
    // new work. Without this, an un-acked entry is never redelivered.
    await reclaimStale(client, handler, {
      consumerName: consumer,
      minIdleMs: reclaimIdleMs,
    }).catch((err) => {
      console.error('[queue-agents:worker] reclaim failed:', err)
    })

    const response = (await client.xreadgroup(
      'GROUP',
      GROUP,
      consumer,
      'COUNT',
      1,
      'BLOCK',
      5000,
      'STREAMS',
      STREAM,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null

    if (!response) continue

    for (const [, entries] of response) {
      for (const [id, fields] of entries) {
        await processEntry(client, id, fields, handler)
      }
    }
  }

  client.disconnect()
}

function fieldsToJob(fields: string[]): ReviewJob | null {
  const map = new Map<string, string>()
  for (let i = 0; i < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!)
  const reviewId = map.get('reviewId')
  const prUrl = map.get('prUrl')
  return reviewId && prUrl ? { reviewId, prUrl } : null
}

// ── Progress pub/sub ──────────────────────────────────────────────────────────

function channel(reviewId: string): string {
  return `review:${reviewId}`
}

export async function publishProgress(reviewId: string, event: unknown): Promise<void> {
  await getValkey().publish(channel(reviewId), JSON.stringify(event))
}

/**
 * Subscribe to one review's progress. Returns an unsubscribe function that also
 * closes the dedicated subscriber connection.
 */
export async function subscribeProgress(
  reviewId: string,
  onEvent: (event: unknown) => void,
): Promise<() => void> {
  const sub = new Redis(url(), { maxRetriesPerRequest: null })
  await sub.subscribe(channel(reviewId))
  sub.on('message', (_channel, message) => {
    try {
      onEvent(JSON.parse(message))
    } catch {
      // ignore malformed messages
    }
  })
  return () => {
    sub.disconnect()
  }
}
