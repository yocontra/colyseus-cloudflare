import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AdmissionLeases } from '../src/admission.ts'
import { FixedRoomClock } from '../src/clock.ts'
import { batchInputs, unpackPackets } from '../src/packets.ts'
import { CloudflareClient } from '../src/socket.ts'
import type { TransactionalDurableSqlStorage } from '../src/sqlite.ts'

test('rollover preserves reservations and use for both rooms', (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const storage: TransactionalDurableSqlStorage = {
    sql: {
      exec<Row>(query: string, ...bindings: (string | number | null)[]) {
        const rows = db.prepare(query).all(...bindings) as Row[]
        return { toArray: () => rows }
      },
    },
    transactionSync(operation) {
      db.exec('BEGIN')
      try {
        const result = operation()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const midnight = Date.UTC(2026, 10, 19)
  const ledger = new AdmissionLeases(storage, {
    dailyActiveSeconds: 20,
    dailyWebSocketMessages: 20,
    leaseSeconds: 10,
    maxMessagesPerSecond: 1,
    renewAfterTicks: 100,
  })
  for (const id of ['a', 'b']) {
    assert.equal(ledger.renew(id, 0, false, midnight - 1000).ok, true)
  }
  assert.equal(ledger.available(midnight).ok, false)
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
    assert.throws(() => ledger.renew('a', count, true, midnight), RangeError)
  }
  ledger.renew('a', 2, true, midnight + 1000)
  assert.equal(ledger.available(midnight + 1000).ok, false)
  ledger.renew('b', 3, true, midnight + 2000)
  assert.equal(ledger.available(midnight + 2000).ok, true)
  const row = db.prepare('SELECT data FROM room_leases WHERE id=1').get()
  assert.deepEqual(JSON.parse(String(row?.data)), {
    day: '2026-11-19',
    seconds: 3,
    messages: 5,
    leases: {},
  })
})

test('large reliable inputs preserve order and subsequent batching', (t) => {
  const sent: Uint8Array[] = []
  const connection = { send: (data: Uint8Array) => sent.push(data) }
  const batching = batchInputs(connection)
  t.after(() => batching.dispose())
  const large = new Uint8Array(2049)
  large[0] = 19
  const first = Uint8Array.of(19, 1)
  const last = Uint8Array.of(19, 2)
  connection.send(first)
  connection.send(large)
  connection.send(last)
  batching.flush()
  assert.deepEqual(
    sent.flatMap((frame) => unpackPackets(frame)),
    [first, large, last],
  )
})

test('socket observers can throw without closing a delivered frame', () => {
  const closes: number[] = []
  const socket = {
    readyState: 1,
    send: () => undefined,
    close: (code?: number) => closes.push(code ?? 0),
  }
  const client = new CloudflareClient('player', socket)
  const failure = new Error('observer failed')
  let callbacks = 0
  assert.throws(
    () =>
      client.raw(Uint8Array.of(19), undefined, () => {
        callbacks++
        throw failure
      }),
    failure,
  )
  client.on('activity', () => {
    throw failure
  })
  assert.throws(() => client.dispatch(Uint8Array.of(19).buffer), failure)
  assert.equal(callbacks, 1)
  assert.deepEqual(closes, [])
})

test('fractional fixed steps advance without wall clock progress', (t) => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 19))
  const step = 1000 / 30
  const clock = new FixedRoomClock(step)
  for (let tick = 0; tick < 60; tick++) {
    clock.tick()
    assert.ok(clock.deltaTime >= step)
  }
  assert.ok(Math.abs(clock.elapsedTime - 2000) < 0.05)
})
