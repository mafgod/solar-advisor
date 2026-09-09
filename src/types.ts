export type GoalMode = 'winter' | 'summer' | 'annual' | 'standby'

export type PhaseType = 'single' | 'three'

export interface Settings {
  amazonTag: string
  aliexpressAffKey: string
}

export interface RoofZone {
  id: string
  corners: { lat: number; lon: number }[]
  azimuthDeg: number
}

export interface LocationInput {
  lat: number
  lon: number
  address: string
  roofAzimuthDeg: number
  roofTiltDeg: number
  availableAreaM2: number
  zones: RoofZone[]
}

export interface ConsumptionInput {
  source: 'manual' | 'eredes'
  fileName?: string
  hourlyKwh: number[]
  monthlyDailyKwh: number[]
  contractedPowerKva: number
  phase: PhaseType
  standbyW: number
  /** Max inverter AC kW; null = no extra legal cap. Typical UPAC simplified threshold is 4 kW. */
  inverterLimitKw: number | null
}

export interface EvInput {
  enabled: boolean
  dailyKm: number
  kwhPer100km: number
  dailyKwhOverride: number | null
  chargePowerKw: number
  chargeHours: boolean[]
}

export interface GoalInput {
  mode: GoalMode
  antiBlackout: boolean
  /** Typical local weather (PVGIS TMY), especially winter cloud and cold. */
  useClimate: boolean
  backupHours: number
  criticalLoadKw: number
  criticalPeakKw: number
  annualCoverage: number
}

export interface StudyInput {
  location: LocationInput
  consumption: ConsumptionInput
  ev: EvInput
  goal: GoalInput
}

export interface StudyFile {
  kind: 'casasolar.study'
  version: 1
  exportedAt: string
  input: StudyInput
  result: StudyResult | null
}

export interface PvgisMonth {
  month: number
  ed: number
  em: number
}

export interface SeasonClimate {
  meanTempC: number
  meanDailyGhiKwhM2: number
  poorDayGhiKwhM2: number
  cloudyDays: number
  maxCloudySpellDays: number
  typicalSpellDays: number
  diffuseRatio: number
  clearness: number
}

export interface LocationClimate {
  source: 'tmy' | 'fallback'
  winter: SeasonClimate
  summer: SeasonClimate
  /** Index 1–12; each vector sums to 1 when irradiance exists. */
  hourlyShapes: number[][]
}

export interface ClimateSummary {
  source: 'tmy' | 'fallback'
  winterMeanTempC: number
  summerMeanTempC: number
  winterMeanDailyGhi: number
  winterPoorDayGhi: number
  winterCloudyDays: number
  winterTypicalSpellDays: number
  winterDiffusePct: number
  winterClearnessPct: number
}

export interface PvgisData {
  source: 'pvgis' | 'openmeteo' | 'fallback'
  yearlyKwhPerKwp: number
  monthly: PvgisMonth[]
  optimalTilt?: number
  optimalAzimuthPvgis?: number
  optimalYearlyKwhPerKwp?: number
  climate: LocationClimate
}

export interface DaySim {
  /** Início do intervalo, em horas desde a meia-noite (0, 0.5, …). */
  hour: number
  loadKwh: number
  pvKwh: number
  gridImportKwh: number
  exportKwh: number
  batteryKwh: number
  socKwh: number
}

export interface ProductLink {
  amazon?: string
  aliexpress?: string
}

export interface Product {
  id: string
  category: 'painel' | 'inversor' | 'bateria' | 'ats' | 'protecao' | 've'
  brand: string
  model: string
  spec: string
  why: string
  search: string
  qty?: number
}

export interface StudyResult {
  pvKwp: number
  panelWatts: number
  panelCount: number
  inverterKw: number
  inverterPhase: PhaseType
  batteryKwh: number
  usableBatteryKwh: number
  atsRequired: boolean
  specificYield: number
  annualPvKwh: number
  annualLoadKwh: number
  selfConsumptionPct: number
  autarkyPct: number
  winterCoveragePct: number
  summerExportKwhDay: number
  backupHoursEffective: number
  roofVsOptimalPct: number
  day: DaySim[]
  dayBest?: DaySim[]
  dayWorst?: DaySim[]
  bestMonth?: number
  worstMonth?: number
  notes: string[]
  products: Product[]
  protections: string[]
  climate?: ClimateSummary
}
