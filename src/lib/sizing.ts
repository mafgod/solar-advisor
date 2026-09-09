import type {
  DaySim,
  GoalMode,
  PhaseType,
  PvgisData,
  StudyInput,
  StudyResult,
} from '../types'
import {
  batteryWinterFactor,
  climateShape,
  summarizeClimate,
  winterClimateShape,
  winterDesignYieldPerKwp,
  winterSpellExtraDays,
} from './climate'
import { averageEd, monthEd } from './pvgis'
import {
  DAY_STEPS,
  halfHourPvShape,
  hourlyPvShape,
  refineHourlyWithShape,
  scaleShape,
  STEP_HOURS,
  SUMMER_MONTHS,
  toHalfHourEnergy,
  WINTER_MONTHS,
} from './solar'
import { effectiveAzimuth } from './geo'
import { clampEvChargePower } from './ev'

const PANEL_W = 450
const PANEL_M2 = 2.3
const DOD = 0.9
const RTE = 0.9
const SINGLE_INVERTER_SIZES = [3, 3.6, 5, 6, 8, 10]
const THREE_INVERTER_SIZES = [3, 3.6, 5, 6, 8, 10, 12, 15]
const BATTERY_STEPS = [2.4, 5, 7.2, 9.6, 14, 15, 20, 28]

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function pickInverter(kw: number, phase: PhaseType, maxKw: number | null): number {
  const sizes = phase === 'three' ? THREE_INVERTER_SIZES : SINGLE_INVERTER_SIZES
  const phaseMax = sizes[sizes.length - 1]
  const cap = maxKw != null && maxKw > 0 ? Math.min(maxKw, phaseMax) : null
  const need = cap != null ? Math.min(kw, cap) : kw
  const allowed = cap != null ? sizes.filter((s) => s <= cap + 0.05) : sizes
  const found = allowed.find((s) => s >= need - 0.05)
  if (found) return found
  if (cap != null) return Math.round(cap * 10) / 10
  return phaseMax
}

function pickBattery(kwh: number): number {
  if (kwh <= 0) return 0
  const found = BATTERY_STEPS.find((s) => s >= kwh - 0.15)
  return found ?? Math.ceil(kwh / 5) * 5
}

function maxKwp(areaM2: number): number {
  const byArea = (areaM2 / PANEL_M2) * (PANEL_W / 1000)
  return clamp(byArea, 0.45, 20)
}

function evDailyKwh(input: StudyInput): number {
  if (!input.ev.enabled) return 0
  if (input.ev.dailyKwhOverride != null && input.ev.dailyKwhOverride > 0) {
    return input.ev.dailyKwhOverride
  }
  return (input.ev.dailyKm * input.ev.kwhPer100km) / 100
}

function evHourly(input: StudyInput): number[] {
  const daily = evDailyKwh(input)
  const hours = input.ev.chargeHours
    .map((on, h) => (on ? h : -1))
    .filter((h) => h >= 0)
  const out = new Array(24).fill(0)
  if (!input.ev.enabled || daily <= 0 || hours.length === 0) return out
  let remaining = daily
  for (const h of hours) {
    const cap = clampEvChargePower(input.ev.chargePowerKw, input.consumption.phase)
    const add = Math.min(cap, remaining)
    out[h] += add
    remaining -= add
    if (remaining <= 0) break
  }
  if (remaining > 0 && hours.length) {
    out[hours[hours.length - 1]] += remaining
  }
  return out
}

function combineLoad(base: number[], ev: number[]): number[] {
  return base.map((v, i) => v + ev[i])
}

function standbyKw(input: StudyInput): number {
  return Math.max(0.04, input.consumption.standbyW / 1000)
}

function typicalLoad(input: StudyInput, months: number[]): number[] {
  const monthly = input.consumption.monthlyDailyKwh
  const hasMonthly = monthly.some((v) => v > 0)
  if (!hasMonthly) return [...input.consumption.hourlyKwh]
  const selected = months
    .map((m) => monthly[m - 1])
    .filter((v) => v > 0)
  const avgDaily = selected.length
    ? selected.reduce((a, b) => a + b, 0) / selected.length
    : input.consumption.hourlyKwh.reduce((a, b) => a + b, 0)
  const baseDaily = input.consumption.hourlyKwh.reduce((a, b) => a + b, 0) || 1
  const scale = avgDaily / baseDaily
  return input.consumption.hourlyKwh.map((v) => v * scale)
}

function representativeMonth(mode: GoalMode): number {
  if (mode === 'winter' || mode === 'standby') return 1
  if (mode === 'summer') return 7
  return 4
}

function monthsFor(mode: GoalMode): number[] {
  if (mode === 'winter' || mode === 'standby') return WINTER_MONTHS
  if (mode === 'summer') return SUMMER_MONTHS
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
}

function extremaMonths(pvgis: PvgisData): { best: number; worst: number } {
  let best = 7
  let worst = 12
  let bestEd = Number.NEGATIVE_INFINITY
  let worstEd = Number.POSITIVE_INFINITY
  for (const row of pvgis.monthly) {
    if (row.ed > bestEd) {
      bestEd = row.ed
      best = row.month
    }
    if (row.ed < worstEd) {
      worstEd = row.ed
      worst = row.month
    }
  }
  return { best, worst }
}

function asHalfHourPvShape(
  shape: number[],
  lat: number,
  month: number,
  tilt: number,
  azimuth: number,
  lon: number,
): number[] {
  const geo = halfHourPvShape(lat, month, tilt, azimuth, lon)
  if (shape.length === DAY_STEPS) return shape
  return refineHourlyWithShape(shape, geo)
}

function simulate(opts: {
  pvKwp: number
  batteryKwh: number
  inverterKw: number
  load: number[]
  pvShape: number[]
  pvDaily: number
}): { day: DaySim[]; self: number; load: number; export: number; import: number } {
  const usable = opts.batteryKwh * DOD
  let soc = usable * 0.5
  const dt = STEP_HOURS
  const loadSlots = toHalfHourEnergy(opts.load)
  const pvSlots = scaleShape(
    opts.pvShape.length === DAY_STEPS ? opts.pvShape : toHalfHourEnergy(opts.pvShape),
    opts.pvDaily * opts.pvKwp,
  )
  const day: DaySim[] = []
  let self = 0
  let load = 0
  let exp = 0
  let imp = 0

  for (let i = 0; i < DAY_STEPS; i++) {
    const L = loadSlots[i] ?? 0
    load += L
    const pvAc = Math.min((pvSlots[i] ?? 0) * 0.98, opts.inverterKw * dt)
    let gridImport = 0
    let gridExport = 0
    if (pvAc >= L) {
      let surplus = pvAc - L
      self += L
      const room = usable - soc
      const loadKw = dt > 0 ? L / dt : 0
      const charge = Math.min(surplus, room, Math.max(0, opts.inverterKw - loadKw) * dt) * RTE
      soc += charge
      surplus -= charge / RTE
      if (surplus > 0) gridExport = surplus
    } else {
      const deficit = L - pvAc
      self += pvAc
      const discharge = Math.min(deficit, soc, opts.inverterKw * dt)
      soc -= discharge
      const delivered = discharge * RTE
      self += Math.min(delivered, deficit)
      const still = deficit - delivered
      if (still > 0) gridImport = still
    }
    soc = clamp(soc, 0, usable)
    exp += gridExport
    imp += gridImport
    day.push({
      hour: i * dt,
      loadKwh: L,
      pvKwh: pvAc,
      gridImportKwh: gridImport,
      exportKwh: gridExport,
      batteryKwh: pvAc >= L ? Math.min(pvAc - L, usable - soc) : 0,
      socKwh: soc,
    })
  }

  return { day, self, load, export: exp, import: imp }
}

function eveningDeficit(load: number[], pvHour: number[]): number {
  const L = toHalfHourEnergy(load)
  const P = pvHour.length === DAY_STEPS ? pvHour : toHalfHourEnergy(pvHour)
  let def = 0
  for (let i = 0; i < DAY_STEPS; i++) {
    const hour = i * STEP_HOURS
    if (hour < 8 || hour >= 17) def += Math.max(0, (L[i] ?? 0) - (P[i] ?? 0))
  }
  return def
}

function sizePv(opts: {
  mode: GoalMode
  load: number[]
  standbyLoad: number[]
  pvgis: PvgisData
  maxKwp: number
  coverage: number
  useClimate: boolean
}): number {
  const daily = opts.load.reduce((a, b) => a + b, 0)
  const winterEd = opts.useClimate
    ? winterDesignYieldPerKwp(opts.pvgis)
    : Math.max(1.4, averageEd(opts.pvgis, WINTER_MONTHS))
  const summerEd = averageEd(opts.pvgis, SUMMER_MONTHS)

  switch (opts.mode) {
    case 'winter':
      return clamp((daily / winterEd) * (opts.useClimate ? 1.08 : 1.05), 0.45, opts.maxKwp)
    case 'summer':
      return clamp((daily / Math.max(2, summerEd)) * 0.72, 0.45, opts.maxKwp)
    case 'standby': {
      const stand = opts.standbyLoad.reduce((a, b) => a + b, 0)
      const floor = opts.useClimate ? 1.0 : 1.2
      return clamp((stand / Math.max(floor, winterEd)) * 1.15, 0.45, Math.min(3, opts.maxKwp))
    }
    default:
      return clamp((daily * 365 * opts.coverage) / opts.pvgis.yearlyKwhPerKwp, 0.45, opts.maxKwp)
  }
}

function backupPvKwp(opts: {
  pvgis: PvgisData
  backupHours: number
  standbyKw: number
  maxKwp: number
  useClimate: boolean
}): number {
  const winterEd = opts.useClimate
    ? winterDesignYieldPerKwp(opts.pvgis)
    : Math.max(1.5, averageEd(opts.pvgis, WINTER_MONTHS))
  const dailyHours = Math.min(24, opts.backupHours)
  const recover = (opts.standbyKw * dailyHours) / Math.max(1.2, winterEd * (opts.useClimate ? 0.75 : 0.7))
  return clamp(Math.max(recover, 0.9), 0.45, opts.maxKwp)
}

function backupBatteryKwh(backupHours: number, loadKw: number): number {
  return (loadKw * backupHours) / (DOD * 0.94)
}

function sizeBattery(opts: {
  mode: GoalMode
  load: number[]
  pvKwp: number
  pvDailyPerKwp: number
  pvShape: number[]
  pvgis: PvgisData
  standbyW: number
  useClimate: boolean
}): number {
  const pvHour = scaleShape(opts.pvShape, opts.pvDailyPerKwp * opts.pvKwp)
  const night = eveningDeficit(opts.load, pvHour)
  const dailyLoad = opts.load.reduce((a, b) => a + b, 0)
  const dailyPv = pvHour.reduce((a, b) => a + b, 0)
  const extraDays = opts.useClimate ? winterSpellExtraDays(opts.pvgis) : 0
  const extra = Math.max(0, dailyLoad - dailyPv) * extraDays
  const cold = opts.useClimate ? batteryWinterFactor(opts.pvgis) : 1

  switch (opts.mode) {
    case 'standby':
      return ((opts.standbyW / 1000) * (14 + extraDays * 8)) / (DOD * cold)
    case 'summer':
      return Math.max(2.4, night * 0.7)
    case 'winter':
      return Math.max(5, (night + extra) / (DOD * cold))
    default:
      return Math.max(5, (night + extra * 0.7) / (DOD * cold))
  }
}

function phaseFor(input: StudyInput): PhaseType {
  return input.consumption.phase
}

export function sizeSystem(input: StudyInput, pvgis: PvgisData): StudyResult {
  const months = monthsFor(input.goal.mode)
  const month = representativeMonth(input.goal.mode)
  const baseLoad = typicalLoad(input, months)
  const standbyHour = input.consumption.standbyW / 1000
  const standbyLoad = new Array(24).fill(standbyHour)
  const load =
    input.goal.mode === 'standby'
      ? standbyLoad
      : combineLoad(baseLoad, evHourly(input))

  const cap = maxKwp(Math.max(input.location.availableAreaM2, 2.3))
  const azimuth = effectiveAzimuth(input.location)
  const tilt = input.location.roofTiltDeg
  const lat = input.location.lat
  const lon = input.location.lon
  const useClimate = input.goal.useClimate
  const winterShape = asHalfHourPvShape(
    useClimate
      ? winterClimateShape(pvgis, lat, lon, tilt, azimuth)
      : hourlyPvShape(lat, 1, tilt, azimuth, lon),
    lat,
    1,
    tilt,
    azimuth,
    lon,
  )
  const shape =
    input.goal.mode === 'winter' || input.goal.mode === 'standby'
      ? winterShape
      : asHalfHourPvShape(
          useClimate
            ? climateShape(pvgis, month, lat, lon, tilt, azimuth)
            : hourlyPvShape(lat, month, tilt, azimuth, lon),
          lat,
          month,
          tilt,
          azimuth,
          lon,
        )
  const pvDailyPerKwp =
    input.goal.mode === 'winter' || input.goal.mode === 'standby'
      ? useClimate
        ? winterDesignYieldPerKwp(pvgis)
        : monthEd(pvgis, month)
      : input.goal.mode === 'summer'
        ? averageEd(pvgis, SUMMER_MONTHS)
        : monthEd(pvgis, month)

  let pvKwp = sizePv({
    mode: input.goal.mode,
    load,
    standbyLoad,
    pvgis,
    maxKwp: cap,
    coverage: input.goal.annualCoverage,
    useClimate,
  })
  const islandKw = standbyKw(input)
  if (input.goal.antiBlackout) {
    pvKwp = Math.max(
      pvKwp,
      backupPvKwp({
        pvgis,
        backupHours: input.goal.backupHours,
        standbyKw: islandKw,
        maxKwp: cap,
        useClimate,
      }),
    )
  }

  pvKwp = roundTo(pvKwp, PANEL_W / 1000)
  pvKwp = clamp(pvKwp, PANEL_W / 1000, cap)
  let panelCount = Math.max(1, Math.round((pvKwp * 1000) / PANEL_W))
  while (panelCount * PANEL_M2 > input.location.availableAreaM2 + 0.4 && panelCount > 1) {
    panelCount -= 1
  }
  pvKwp = (panelCount * PANEL_W) / 1000

  let batteryRaw = sizeBattery({
    mode: input.goal.mode,
    load,
    pvKwp,
    pvDailyPerKwp:
      useClimate && input.goal.mode !== 'summer' ? winterDesignYieldPerKwp(pvgis) : pvDailyPerKwp,
    pvShape: useClimate && input.goal.mode !== 'summer' ? winterShape : shape,
    pvgis,
    standbyW: input.consumption.standbyW,
    useClimate,
  })
  if (input.goal.antiBlackout) {
    batteryRaw = Math.max(
      batteryRaw,
      backupBatteryKwh(input.goal.backupHours, islandKw),
    )
  }
  const batteryKwh = pickBattery(batteryRaw)

  const peakLoad = Math.max(...load)
  const dcAc = pvKwp / 1.15
  const inverterNeed = Math.max(dcAc, peakLoad)
  const inverterPhase = phaseFor(input)
  const inverterKw = pickInverter(inverterNeed, inverterPhase, input.consumption.inverterLimitKw)
  const sim = simulate({
    pvKwp,
    batteryKwh,
    inverterKw,
    load,
    pvShape: shape,
    pvDaily: pvDailyPerKwp,
  })

  const roofVsOptimal =
    pvgis.optimalYearlyKwhPerKwp && pvgis.optimalYearlyKwhPerKwp > 0
      ? (pvgis.yearlyKwhPerKwp / pvgis.optimalYearlyKwhPerKwp) * 100
      : 100

  const winterLoad = combineLoad(typicalLoad(input, WINTER_MONTHS), evHourly(input))
  const winterSim = simulate({
    pvKwp,
    batteryKwh,
    inverterKw,
    load: input.goal.mode === 'standby' ? standbyLoad : winterLoad,
    pvShape: winterShape,
    pvDaily: useClimate ? winterDesignYieldPerKwp(pvgis) : averageEd(pvgis, WINTER_MONTHS),
  })
  const summerSim = simulate({
    pvKwp,
    batteryKwh,
    inverterKw,
    load: combineLoad(typicalLoad(input, SUMMER_MONTHS), evHourly(input)),
    pvShape: asHalfHourPvShape(
      useClimate
        ? climateShape(pvgis, 7, lat, lon, tilt, azimuth)
        : hourlyPvShape(lat, 7, tilt, azimuth, lon),
      lat,
      7,
      tilt,
      azimuth,
      lon,
    ),
    pvDaily: averageEd(pvgis, SUMMER_MONTHS),
  })

  const { best: bestMonth, worst: worstMonth } = extremaMonths(pvgis)
  const extremaLoad = (month: number) =>
    input.goal.mode === 'standby'
      ? standbyLoad
      : combineLoad(typicalLoad(input, [month]), evHourly(input))
  const clearSkyDay = (month: number) =>
    simulate({
      pvKwp,
      batteryKwh,
      inverterKw,
      load: extremaLoad(month),
      pvShape: halfHourPvShape(lat, month, tilt, azimuth, lon),
      pvDaily: monthEd(pvgis, month),
    })
  const bestSim = clearSkyDay(bestMonth)
  const worstSim = clearSkyDay(worstMonth)

  const annualLoadKwh =
    (input.consumption.monthlyDailyKwh.some((v) => v > 0)
      ? input.consumption.monthlyDailyKwh.reduce((a, b) => a + b, 0) * 30.4
      : load.reduce((a, b) => a + b, 0) * 365) + (input.goal.mode === 'standby' ? 0 : evDailyKwh(input) * 365)

  const notes = buildNotes(input, {
    pvKwp,
    batteryKwh,
    inverterKw,
    inverterNeed,
    inverterPhase,
    roofVsOptimal,
    cap,
    pvgis,
  })

  const atsRequired = input.goal.antiBlackout
  const backupHoursEffective =
    islandKw > 0 ? (batteryKwh * DOD * 0.94) / islandKw : 0

  const result: StudyResult = {
    pvKwp,
    panelWatts: PANEL_W,
    panelCount,
    inverterKw,
    inverterPhase,
    batteryKwh,
    usableBatteryKwh: batteryKwh * DOD,
    atsRequired,
    specificYield: pvgis.yearlyKwhPerKwp,
    annualPvKwh: pvKwp * pvgis.yearlyKwhPerKwp,
    annualLoadKwh,
    selfConsumptionPct: sim.load > 0 ? (sim.self / sim.load) * 100 : 0,
    autarkyPct: sim.load > 0 ? (1 - sim.import / sim.load) * 100 : 0,
    winterCoveragePct: winterSim.load > 0 ? (1 - winterSim.import / winterSim.load) * 100 : 0,
    summerExportKwhDay: summerSim.export,
    backupHoursEffective,
    roofVsOptimalPct: roofVsOptimal,
    day: sim.day,
    dayBest: bestSim.day,
    dayWorst: worstSim.day,
    bestMonth,
    worstMonth,
    notes,
    products: [],
    climate: useClimate ? summarizeClimate(pvgis.climate) : undefined,
    protections: [
      'Fusíveis gPV por string no quadro DC',
      'Seccionador DC junto ao inversor',
      'SPD Tipo 2 DC (1000 Vcc)',
      'Diferencial Tipo B 30 mA no AC do inversor',
      'Disjuntor magnetotérmico AC (curva C)',
      'SPD Tipo 2 AC no quadro geral',
      atsRequired
        ? 'ATS no ramal do quadro geral: com rede o inversor opera em grid-tie em paralelo com a instalação; sem rede o ATS alimenta toda a casa pela saída EPS/backup, com intertravamento e neutro comutado'
        : 'Sem ATS (só autoconsumo on-grid, sem ilhamento)',
      'Ligação equipotencial e terra da estrutura dos módulos',
    ],
  }
  return result
}

function buildNotes(
  input: StudyInput,
  ctx: {
    pvKwp: number
    batteryKwh: number
    inverterKw: number
    inverterNeed: number
    inverterPhase: PhaseType
    roofVsOptimal: number
    cap: number
    pvgis: PvgisData
  },
): string[] {
  const notes: string[] = []
  const az = effectiveAzimuth(input.location)
  if (input.location.zones.length > 1) {
    notes.push(
      `Foram consideradas ${input.location.zones.length} águas (${input.location.availableAreaM2.toFixed(1)} m²). A produção PVGIS usa o azimute médio ponderado pela área.`,
    )
  }
  if (az < 90 || az > 270) {
    notes.push(
      'O telhado aponta para norte: a produção cai bastante. Considere fachada sul, estrutura elevada ou um carport orientado a sul.',
    )
  } else if (ctx.roofVsOptimal < 88) {
    notes.push(
      `A orientação/inclinação atual rende cerca de ${ctx.roofVsOptimal.toFixed(0)} % do ótimo PVGIS para este local. Ainda é viável, mas cada kWp produz menos.`,
    )
  } else {
    notes.push(
      `Orientação favorável: cerca de ${ctx.roofVsOptimal.toFixed(0)} % do ângulo ótimo PVGIS neste local.`,
    )
  }

  if (ctx.pvgis.source === 'fallback') {
    notes.push(
      'Não foi possível obter dados solares deste local; usei um perfil típico de Lisboa. Confirme a produção com o estudo do instalador.',
    )
  } else {
    const src = ctx.pvgis.source === 'openmeteo' ? 'Open-Meteo' : 'PVGIS'
    notes.push(
      `Produtividade específica ${src}: ${ctx.pvgis.yearlyKwhPerKwp.toFixed(0)} kWh/kWp·ano (perdas de sistema 14 %). Os gráficos horários usam a hora civil local da habitação.`,
    )
  }

  if (input.goal.useClimate) {
    const winter = ctx.pvgis.climate.winter
    const designEd = winterDesignYieldPerKwp(ctx.pvgis)
    const climateSrc =
      ctx.pvgis.climate.source === 'tmy'
        ? 'ano meteorológico tipo (TMY) deste local'
        : 'perfil climático de referência (Lisboa)'
    notes.push(
      `Previsão do clima ligada. Inverno (${climateSrc}): ${winter.meanTempC.toFixed(0)} °C, ${winter.meanDailyGhiKwhM2.toFixed(1)} kWh/m²·dia, cerca de ${winter.cloudyDays} dias nublados e sequências típicas de ${winter.typicalSpellDays} dia${winter.typicalSpellDays === 1 ? '' : 's'}. O céu típico rende cerca de ${Math.round(winter.clearness * 100)} % de um dia limpo.`,
    )
    notes.push(
      `O campo FV e a bateria usam um dia pobre de inverno (~${designEd.toFixed(1)} kWh/kWp, percentil 20 da irradiância) e a capacidade útil da bateria em frio, não um dia de céu limpo.`,
    )
  } else {
    notes.push(
      'Previsão do clima desligada: o cálculo usa a produção média mensal do PVGIS, sem dias nublados extra nem correção da bateria no frio.',
    )
  }

  notes.push(
    'Os gráficos de melhor e pior dia usam a produção média mensal do PVGIS, sem a previsão do clima, mesmo que esta tenha sido usada no dimensionamento.',
  )

  switch (input.goal.mode) {
    case 'winter':
      notes.push(
        input.goal.useClimate
          ? 'Modo inverno: o campo FV é maior para compensar dias curtos e nublados. No verão haverá excedente — avalie venda de sobras ou um VE a carregar de dia.'
          : 'Modo inverno: o campo FV é maior para compensar dias curtos. No verão haverá excedente — avalie venda de sobras ou um VE a carregar de dia.',
      )
      break
    case 'summer':
      notes.push(
        input.goal.useClimate
          ? 'Modo verão: dimensionado para o clima estival habitual, sem inflacionar o campo FV. Num inverno nublado a autonomia será baixa.'
          : 'Modo verão: dimensionado para autoconsumo estival sem inflacionar o campo FV. No inverno a autonomia será baixa.',
      )
      break
    case 'annual':
      notes.push(
        input.goal.useClimate
          ? `Modo anual: cobertura alvo de ${(input.goal.annualCoverage * 100).toFixed(0)} % do consumo anual (incluindo VE se ativo). A bateria ainda prevê sequências nubladas de inverno neste local.`
          : `Modo anual: cobertura alvo de ${(input.goal.annualCoverage * 100).toFixed(0)} % do consumo anual (incluindo VE se ativo).`,
      )
      break
    case 'standby':
      notes.push(
        input.goal.useClimate
          ? `Modo standby: cobre cerca de ${input.consumption.standbyW} W contínuos (router, alarme, placa de indução em espera, etc.) mesmo em inverno nublado. Não alimenta a casa toda.`
          : `Modo standby: cobre cerca de ${input.consumption.standbyW} W contínuos (router, alarme, placa de indução em espera, etc.). Não alimenta a casa toda.`,
      )
      break
  }

  if (input.goal.antiBlackout) {
    const hours = input.goal.backupHours
    const days = hours / 24
    const duration =
      hours < 24
        ? `${hours} h`
        : `${days === 1 ? '1 dia' : `${String(Math.round(days * 10) / 10).replace('.', ',')} dias`} (${hours} h)`
    notes.push(
      `Anti-apagão: com rede o inversor fica em grid-tie em paralelo com o quadro geral; em falha o ATS comuta o quadro geral para a saída EPS/backup. A autonomia está calculada só para o standby (~${input.consumption.standbyW} W) durante ${duration}.`,
    )
    notes.push(
      input.ev.enabled
        ? 'O wallbox fica no quadro geral. Em falha de rede não carregue o VE nem ligue o resto da casa: a bateria está dimensionada para o standby e esgota-se depressa.'
        : 'Em falha de rede não carregue o VE nem ligue o resto da casa: a autonomia está dimensionada só para o standby.',
    )
  }

  if (input.ev.enabled && !input.goal.antiBlackout) {
    notes.push(
      'Se o VE carregar de dia, o inversor limita a potência solar que o wallbox consegue aproveitar.',
    )
  }

  const inverterCap = input.consumption.inverterLimitKw
  if (inverterCap != null && inverterCap > 0) {
    notes.push(
      `Limitei o inversor a ${ctx.inverterKw} kW AC (teto ${inverterCap} kW) para ficar no regime em que normalmente não é exigido um contador de produção extra nem módulo de comunicações (SIM) para as leituras mensais.`,
    )
    if (ctx.inverterNeed > ctx.inverterKw + 0.05) {
      const ratio = ctx.inverterKw > 0 ? ctx.pvKwp / ctx.inverterKw : 0
      notes.push(
        `Sem este teto o inversor seria cerca de ${ctx.inverterNeed.toFixed(1)} kW. Com ${ctx.inverterKw} kW há clipping nos picos de produção ou de carga (relação DC/AC ${ratio.toFixed(2)}).`,
      )
    }
  }

  if (ctx.inverterPhase === 'single') {
    notes.push(
      'A habitação é monofásica: inversor, proteções AC e ATS (se houver) são monofásicos. Não apresento trifásico sem alterar o ramal da E-REDES.',
    )
    const maxSingle = SINGLE_INVERTER_SIZES[SINGLE_INVERTER_SIZES.length - 1]
    if (ctx.inverterNeed > maxSingle + 0.05) {
      notes.push(
        `A potência pretendida (~${ctx.inverterNeed.toFixed(1)} kW) ultrapassa o máximo monofásico desta solução (${maxSingle} kW). Mantive inversor monofásico; para mais potência seria necessário passar o contador a trifásico.`,
      )
    }
  } else {
    notes.push('A habitação é trifásica: inversor e ATS (se houver) seguem ramal a 400 V.')
  }

  if (ctx.pvKwp >= ctx.cap - 0.05) {
    notes.push(
      'A área de telhado disponível limita o campo FV. Mais módulos exigiriam outra água, solo ou carport.',
    )
  }

  notes.push(
    'Isto é um pré-dimensionamento. O projeto certificado (DRE / Certiel / instalador) prevalece sobre este estudo.',
  )
  return notes
}

export function defaultHourlyProfile(dailyKwh: number): number[] {
  const shape = [
    0.028, 0.024, 0.022, 0.021, 0.021, 0.024, 0.035, 0.048, 0.045, 0.04, 0.038,
    0.04, 0.042, 0.04, 0.038, 0.04, 0.05, 0.07, 0.08, 0.075, 0.06, 0.05, 0.04,
    0.034,
  ]
  const sum = shape.reduce((a, b) => a + b, 0)
  return shape.map((v) => (v / sum) * dailyKwh)
}
