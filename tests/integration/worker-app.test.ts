delete process.env.DATABASE_URL

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../packages/queue-agents/src/web.js'
import { closeValkey } from '../../packages/queue-agents/src/kv.js'

const app = createApp()

after(async () => {
  await closeValkey()
})

test('worker web serves the shared telemetry viewer', async () => {
  const res = await app.fetch(new Request('http://test/'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<!doctype html>/i)
})

test('worker web validates the review body', async () => {
  const res = await app.fetch(
    new Request('http://test/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  assert.equal(res.status, 400)
})

// Enqueueing needs a real Valkey instance (the worker is a separate process), so
// this only runs when VALKEY_URL is set; otherwise it's skipped to keep the suite offline.
test('POST /api/reviews enqueues a job', { skip: !process.env.VALKEY_URL }, async () => {
  const res = await app.fetch(
    new Request('http://test/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl: 'https://github.com/o/r/pull/1' }),
    }),
  )
  assert.equal(res.status, 202)
  const body = (await res.json()) as { id: string; status: string }
  assert.equal(body.status, 'queued')
})
