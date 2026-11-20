/** Independently authored Colyseus 0.18 Client/ClientPrivate adapter over DO-owned sockets.
 * Community feasibility research: c-py/colyseus-cloudflare-worker-transport
 * b0f296e444867dc2edb47e351c28b7238e08289f (UNLICENSED; no source incorporated).
 * Protocol encoding and outgoing queue semantics come from official @colyseus/core.
 */

import { EventEmitter } from 'node:events'
import {
  type Client,
  type ClientPrivate,
  ClientState,
  enqueueClientRaw,
  getMessageBytes,
  type ISendOptions,
  Protocol,
} from '@colyseus/core'
import { PROTOCOL_CODE_MASK } from '@colyseus/shared-types'
import { unpackPackets } from './packets.ts'

/** Sustained frames per second, each carrying at most two SDK packets. */
const FRAME_RATE = 20
/** A stalled tab or radio delivers its queued frames at once; three seconds of backlog is play. */
const FRAME_BURST = FRAME_RATE * 3
const JOIN_TIMEOUT_MS = 15_000
const MAX_JOIN_QUEUE_FRAMES = 256
const MAX_JOIN_QUEUE_BYTES = 1024 * 1024
const MAX_CLOSE_REASON_BYTES = 123
const utf8 = new TextEncoder()

type RoomSocket = Pick<WebSocket, 'readyState' | 'send' | 'close'>

export class CloudflareClient
  extends EventEmitter
  implements Client, ClientPrivate
{
  declare _pendingFrames?: Uint8Array[]
  declare '~messages': Record<string | number, unknown>
  readonly ref = this
  readonly sessionId: string
  readonly ws: RoomSocket
  state: ClientState = ClientState.JOINING
  reconnectionToken = ''
  _enqueuedMessages: Uint8Array[] = []
  _joinedAt = 0
  private closeState: 'open' | 'closing' | 'disconnected' = 'open'
  private joinTimer: ReturnType<typeof setTimeout> | undefined
  private joinQueueFrames = 0
  private joinQueueBytes = 0
  private frameTokens = FRAME_BURST
  private refilledAt = Date.now()
  private readonly delivered: (bytes: number) => void
  constructor(
    sessionId: string,
    ws: RoomSocket,
    delivered: (bytes: number) => void = () => undefined,
  ) {
    super()
    this.sessionId = sessionId
    this.ws = ws
    this.delivered = delivered
  }
  get readyState() {
    return this.ws.readyState
  }
  raw(data: Uint8Array, _options?: ISendOptions, cb?: (error?: Error) => void) {
    if (this.closeState !== 'open') {
      cb?.(new Error('Connection closed'))
      return
    }
    try {
      this.ws.send(Uint8Array.from(data))
    } catch (error) {
      this.leave(1011, 'Connection unavailable')
      cb?.(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (
      this.state === ClientState.JOINING &&
      this.joinTimer === undefined &&
      ((data[0] ?? 0) & PROTOCOL_CODE_MASK) === Protocol.JOIN_ROOM
    ) {
      this.joinTimer = setTimeout(() => {
        if (this.state === ClientState.JOINING) {
          this.rejectJoin('Join acknowledgement timed out')
        }
      }, JOIN_TIMEOUT_MS)
    }
    this.delivered(data.byteLength)
    cb?.()
  }
  enqueueRaw(data: Uint8Array, options?: ISendOptions) {
    if (this.closeState !== 'open') {
      return
    }
    if (this.state !== ClientState.JOINED) {
      this.joinQueueFrames++
      this.joinQueueBytes += data.byteLength
      if (
        this.joinQueueFrames > MAX_JOIN_QUEUE_FRAMES ||
        this.joinQueueBytes > MAX_JOIN_QUEUE_BYTES
      ) {
        this.rejectJoin('Join message queue exceeded')
        return
      }
    }
    enqueueClientRaw(this, data, options)
  }
  send(
    type: string | number | symbol,
    message?: unknown,
    options?: ISendOptions,
  ) {
    if (typeof type === 'symbol') {
      throw new Error('Symbol message type unsupported')
    }
    this.enqueueRaw(
      getMessageBytes.raw(Protocol.ROOM_DATA, type, message),
      options,
    )
  }
  sendBytes(type: string | number, bytes: Uint8Array, options?: ISendOptions) {
    this.enqueueRaw(
      getMessageBytes.raw(Protocol.ROOM_DATA_BYTES, type, undefined, bytes),
      options,
    )
  }
  leave(code = 1000, reason = '') {
    if (this.closeState !== 'open') {
      return
    }
    const safeReason =
      reason.length > MAX_CLOSE_REASON_BYTES ||
      utf8.encode(reason).byteLength > MAX_CLOSE_REASON_BYTES
        ? 'Connection closed'
        : reason
    this.ws.close(code, safeReason)
    if (this.closeState === 'open') {
      this.closeState = 'closing'
      this.releaseQueues()
    }
  }
  close(code = 1000, reason = '') {
    this.leave(code, reason)
  }
  error(code: number, message = '') {
    this.raw(getMessageBytes[Protocol.ERROR](code, message))
  }
  dispatch(data: ArrayBuffer | string) {
    if (this.closeState !== 'open') {
      return
    }
    const now = Date.now()
    this.frameTokens = Math.min(
      FRAME_BURST,
      this.frameTokens +
        (Math.max(0, now - this.refilledAt) * FRAME_RATE) / 1000,
    )
    this.refilledAt = now
    if (this.frameTokens < 1) {
      this.leave(1008, 'Message rate exceeded')
      return
    }
    this.frameTokens--
    if (typeof data === 'string') {
      this.leave(1003, 'Binary frames required')
      return
    }
    let packets: readonly Uint8Array[]
    try {
      packets = unpackPackets(new Uint8Array(data))
    } catch {
      this.leave(1009, 'Invalid frame')
      return
    }
    // The timestamp is observed on incoming I/O, unlike a quiet Workers timer clock.
    this.emit('activity', now)
    for (const packet of packets) {
      if (this.closeState !== 'open') {
        break
      }
      if (
        ((packet[0] ?? 0) & PROTOCOL_CODE_MASK) ===
        Protocol.ROOM_INPUT_UNRELIABLE
      ) {
        this.leave(1003, 'Use reliable Colyseus input')
        break
      }
      this.emit('message', packet)
      if (this.state === ClientState.JOINED && this.joinTimer !== undefined) {
        this.clearJoinTimer()
      }
    }
  }
  disconnected(code: number, reason: string) {
    if (this.closeState === 'disconnected') {
      return
    }
    this.closeState = 'disconnected'
    this.releaseQueues()
    this.emit('close', code, reason)
  }

  private rejectJoin(reason: string) {
    // Release the Colyseus seat without waiting for the peer's close acknowledgement.
    try {
      this.leave(1008, reason)
    } finally {
      this.disconnected(1008, reason)
    }
  }

  private releaseQueues() {
    this.clearJoinTimer()
    if (this._enqueuedMessages) {
      this._enqueuedMessages.length = 0
    }
    if (this._pendingFrames) {
      this._pendingFrames.length = 0
    }
  }

  private clearJoinTimer() {
    clearTimeout(this.joinTimer)
    this.joinTimer = undefined
  }
}
