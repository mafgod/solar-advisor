import type { ConsumptionInput, EvInput, GoalInput, GoalMode, LocationInput, Settings, StudyInput } from '../types'
import { defaultHourlyProfile } from './sizing'

export const defaultSettings = (): Settings => ({
  amazonTag: import.meta.env.VITE_AMAZON_TAG ?? '',
  aliexpressAffKey: import.meta.env.VITE_ALIEXPRESS_AFF ?? '',
})

export const defaultLocation = (): LocationInput => ({
  lat: 38.6975,
  lon: -9.4218,
  address: 'Cascais, Portugal',
  roofAzimuthDeg: 180,
  roofTiltDeg: 30,
  availableAreaM2: 0,
  zones: [],
})

export const defaultConsumption = (): ConsumptionInput => ({
  source: 'manual',
  hourlyKwh: defaultHourlyProfile(11),
  monthlyDailyKwh: new Array(12).fill(0),
  contractedPowerKva: 6.9,
  phase: 'single',
  standbyW: 180,
  inverterLimitKw: null,
})

export const defaultEv = (): EvInput => ({
  enabled: false,
  dailyKm: 35,
  kwhPer100km: 16,
  dailyKwhOverride: null,
  chargePowerKw: 7.4,
  chargeHours: Array.from({ length: 24 }, (_, h) => h >= 23 || h < 7),
})

export const defaultGoal = (): GoalInput => ({
  mode: 'annual',
  antiBlackout: false,
  useClimate: true,
  backupHours: 8,
  criticalLoadKw: 0.45,
  criticalPeakKw: 1.2,
  annualCoverage: 0.9,
})

const GOAL_MODES: GoalMode[] = ['winter', 'summer', 'annual', 'standby']

export function normalizeGoal(saved?: Record<string, unknown>): GoalInput {
  const base = defaultGoal()
  const rawMode = typeof saved?.mode === 'string' ? saved.mode : undefined
  const wasBackupOnly = rawMode === 'backup'
  const mode = GOAL_MODES.includes(rawMode as GoalMode) ? (rawMode as GoalMode) : base.mode
  return {
    ...base,
    ...(saved as Partial<GoalInput> | undefined),
    mode,
    antiBlackout:
      typeof saved?.antiBlackout === 'boolean' ? saved.antiBlackout : wasBackupOnly,
    useClimate: typeof saved?.useClimate === 'boolean' ? saved.useClimate : true,
  }
}

export function normalizeInverterLimit(value: unknown): number | null {
  if (value == null || value === false) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(20, Math.max(1, Math.round(n * 10) / 10))
}

export function goalLabel(goal: GoalInput): string {
  const base =
    goal.mode === 'winter'
      ? 'Inverno'
      : goal.mode === 'summer'
        ? 'Verão'
        : goal.mode === 'standby'
          ? 'Standby'
          : 'Anual'
  const extras = [
    goal.useClimate ? 'clima' : null,
    goal.antiBlackout ? 'anti-apagão' : null,
  ].filter((v): v is string => Boolean(v))
  return extras.length ? `${base} + ${extras.join(' + ')}` : base
}

export const defaultStudy = (): StudyInput => ({
  location: defaultLocation(),
  consumption: defaultConsumption(),
  ev: defaultEv(),
  goal: defaultGoal(),
})
