import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClientState } from '@colyseus/core'
import { Protocol } from '@colyseus/shared-types'
import { CloudflareClient } from '../src/socket.ts'

function socketFixture() {
  const closes: { code: number | undefined; reason: string | undefined }[] = []
  const client = new CloudflareClient('player', {
    readyState: 1,
    send: () => undefined,
    close: (code, reason) => closes.push({ code, reason }),
  })
  return { client, closes }
}

test('the WebSocket adapter supports reliable SDK input', () => {
  const { client, closes } = socketFixture()
  const received: Uint8Array[] = []
  client.on('message', (data: Uint8Array) => received.push(data))
  const input = Uint8Array.of(Protocol.ROOM_INPUT_RELIABLE)
  client.dispatch(input.buffer)
  assert.deepEqual(received, [input])
  client.dispatch(Uint8Array.of(Protocol.ROOM_INPUT_UNRELIABLE).buffer)
  assert.equal(closes[0]?.code, 1003)
  client.dispatch(input.buffer)
  assert.deepEqual(received, [input])
})

test('the join deadline stops after acknowledgement and disconnection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = socketFixture()
  const joined = socketFixture()
  const dropped = socketFixture()
  const join = Uint8Array.of(Protocol.JOIN_ROOM)
  for (const { client } of [stalled, joined, dropped]) {
    client.raw(join)
  }
  const stalledEvents: number[] = []
  stalled.client.on('close', (code: number) => stalledEvents.push(code))
  joined.client.on('message', () => {
    joined.client.state = ClientState.JOINED
  })
  joined.client.dispatch(join.buffer)
  dropped.client.disconnected(1000, '')
  t.mock.timers.tick(15_000)
  assert.equal(stalled.closes[0]?.code, 1008)
  assert.deepEqual(stalledEvents, [1008])
  stalled.client.disconnected(1008, '')
  assert.deepEqual(stalledEvents, [1008])
  assert.deepEqual(joined.closes, [])
  assert.deepEqual(dropped.closes, [])
})

test('the join queue frees messages at the frame and byte limits', () => {
  const small = socketFixture()
  const message = Uint8Array.of(Protocol.ROOM_DATA)
  for (let index = 0; index < 256; index++) {
    small.client.enqueueRaw(message)
  }
  assert.deepEqual(small.closes, [])
  small.client.enqueueRaw(message)
  assert.equal(small.closes[0]?.code, 1008)
  assert.deepEqual(small.client._enqueuedMessages, [])

  const large = socketFixture()
  const half = new Uint8Array(512 * 1024)
  large.client.enqueueRaw(half, { afterNextPatch: true })
  large.client.enqueueRaw(half)
  assert.deepEqual(large.closes, [])
  large.client.enqueueRaw(message)
  assert.equal(large.closes[0]?.code, 1008)
  assert.deepEqual(large.client._enqueuedMessages, [])
  assert.deepEqual(large.client._pendingFrames, [])
})

test('close uses a valid UTF-8 reason and reports disconnection once', () => {
  const { client, closes } = socketFixture()
  let disconnects = 0
  client.on('close', () => disconnects++)
  client.leave(1000, 'é'.repeat(62))
  client.disconnected(1000, '')
  client.disconnected(1000, '')
  assert.deepEqual(closes, [{ code: 1000, reason: 'Connection closed' }])
  assert.equal(disconnects, 1)
})

test('an invalid close argument leaves the connection available for a retry', () => {
  const closes: number[] = []
  const client = new CloudflareClient('player', {
    readyState: 1,
    send: () => undefined,
    close: (code) => {
      if (code !== 1000) {
        throw new TypeError('Invalid close code')
      }
      closes.push(code)
    },
  })
  assert.throws(() => client.leave(1006), TypeError)
  client.leave(1000)
  assert.deepEqual(closes, [1000])
})
