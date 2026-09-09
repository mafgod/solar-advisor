import type { PhaseType } from '../types'

export const EV_CHARGE_OPTIONS: { kw: number; label: string; threePhase: boolean }[] = [
  { kw: 2.3, label: 'Schuko 2,3 kW', threePhase: false },
  { kw: 3.7, label: 'Wallbox 3,7 kW', threePhase: false },
  { kw: 7.4, label: 'Wallbox 7,4 kW', threePhase: false },
  { kw: 11, label: 'Wallbox trifásico 11 kW', threePhase: true },
  { kw: 22, label: 'Wallbox trifásico 22 kW', threePhase: true },
]

export function evChargeOptions(phase: PhaseType) {
  return EV_CHARGE_OPTIONS.filter((o) => phase === 'three' || !o.threePhase)
}

export function clampEvChargePower(kw: number, phase: PhaseType): number {
  const allowed = evChargeOptions(phase)
  const match = allowed.find((o) => Math.abs(o.kw - kw) < 1e-6)
  if (match) return match.kw
  const below = [...allowed].reverse().find((o) => o.kw <= kw)
  return below?.kw ?? allowed[allowed.length - 1]?.kw ?? 7.4
}
