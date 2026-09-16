import { clamp01, curve, damp } from '@/core/math'
import type { PressureSource, RawSample } from './types'

/**
 * Resolves a usable pressure signal from whatever the device actually gives us.
 *
 * Three realities have to coexist:
 *  - A real stylus reports pressure per sample. Use it.
 *  - Some styli and most pen drivers report a frozen 0.5 (or 0) forever.
 *  - A mouse or finger has no pressure at all.
 *
 * In the last two cases we synthesise pressure from stroke speed, which is what
 * a real brush does anyway: move fast and the bristles lift, move slowly and
 * they load. The detection runs live, so plugging in a tablet mid-session
 * switches the model over without the user touching a setting.
 */
export class PressureModel {
  private source: PressureSource
  private readonly curveGamma: number
  private readonly velocityMax: number

  /** Smoothed pressure value carried between samples. */
  private value = 0.5
  /** Smoothed speed in document units per millisecond. */
  private speed = 0
  private started = false

  /** Evidence that the device emits genuine, varying pressure. */
  private penSamples = 0
  private penVariation = 0
  private firstPenPressure = -1
  private penConfirmed = false

  constructor(
    source: PressureSource,
    curveGamma: number,
    velocityMax: number
  ) {
    this.source = source
    this.curveGamma = curveGamma
    this.velocityMax = Math.max(0.05, velocityMax)
  }

  /** True once the model is confident it is reading a real pressure-capable pen. */
  get usingRealPressure(): boolean {
    return this.source === 'pen' || (this.source === 'auto' && this.penConfirmed)
  }

  get currentSpeed(): number {
    return this.speed
  }

  /**
   * Feeds one sample and returns the pressure to use for it.
   *
   * @param sample   the raw device sample
   * @param distance distance travelled since the previous accepted sample
   * @param dt       milliseconds since the previous accepted sample
   */
  push(sample: RawSample, distance: number, dt: number): number {
    const safeDt = Math.max(dt, 1)
    const instantSpeed = distance / safeDt

    // Speed is noisy at high report rates; damp it before it drives anything.
    this.speed = this.started
      ? damp(this.speed, instantSpeed, 28, safeDt)
      : instantSpeed

    if (sample.pressure > 0) this.observePen(sample.pressure)

    const target = this.usingRealPressure
      ? this.fromDevice(sample.pressure)
      : this.source === 'constant'
        ? 0.5
        : this.fromVelocity()

    if (!this.started) {
      this.started = true
      // Start from a soft touch rather than snapping to full width.
      this.value = this.usingRealPressure ? target : Math.min(target, 0.65)
      return curve(this.value, this.curveGamma)
    }

    // A real pen needs almost no smoothing; a synthesised signal needs a lot.
    const halfLife = this.usingRealPressure ? 12 : 42
    this.value = damp(this.value, target, halfLife, safeDt)
    return curve(clamp01(this.value), this.curveGamma)
  }

  private fromDevice(pressure: number): number {
    return clamp01(pressure)
  }

  private fromVelocity(): number {
    // Fast strokes thin out, slow strokes bite. The square root keeps the
    // response lively at low speeds where most drawing actually happens.
    const t = clamp01(this.speed / this.velocityMax)
    return clamp01(1 - Math.sqrt(t) * 0.92)
  }

  /**
   * Watches incoming device pressure and decides whether it is real.
   * A driver stuck at a constant value never accumulates variation, so it
   * never flips `penConfirmed` and the velocity model stays in charge.
   */
  private observePen(pressure: number): void {
    if (this.penConfirmed) return
    if (this.firstPenPressure < 0) {
      this.firstPenPressure = pressure
      this.penSamples = 1
      return
    }
    this.penSamples += 1
    this.penVariation = Math.max(
      this.penVariation,
      Math.abs(pressure - this.firstPenPressure)
    )
    // Two conditions, either is enough: the value moved, or it sits at a level
    // no default would produce (0.5 and 0 are the two browser defaults).
    if (this.penVariation > 0.02) this.penConfirmed = true
    else if (
      this.penSamples > 4 &&
      Math.abs(pressure - 0.5) > 0.06 &&
      pressure > 0.02
    )
      this.penConfirmed = true
  }
}

/**
 * Converts stylus tilt into a nib azimuth and a squash factor.
 * Returns the azimuth in radians and how flat the nib is (0 = round).
 */
export const tiltToNib = (
  sample: RawSample
): { azimuth: number; squash: number } => {
  const tx = sample.tiltX
  const ty = sample.tiltY
  if (tx === 0 && ty === 0) return { azimuth: 0, squash: 0 }
  const rx = (tx * Math.PI) / 180
  const ry = (ty * Math.PI) / 180
  // Project the pen axis onto the page plane.
  const px = Math.tan(rx)
  const py = Math.tan(ry)
  const magnitude = Math.min(1, Math.hypot(px, py) / Math.tan(Math.PI / 3))
  return { azimuth: Math.atan2(py, px), squash: magnitude }
}
