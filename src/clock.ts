import { Clock } from '@colyseus/core'
/** DO timer callbacks advance logical time even when the host wall clock is frozen. */
export class FixedRoomClock extends Clock {
  constructor(stepMs = 50) {
    super()
    this.now = () => {
      let next = this.currentTime + stepMs
      if (next - this.currentTime < stepMs) {
        // Round fractional steps up so Colyseus can advance on the first tick.
        next += Math.abs(next) * Number.EPSILON
      }
      return Math.max(Date.now(), next)
    }
  }
}
