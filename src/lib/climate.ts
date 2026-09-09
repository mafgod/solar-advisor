import type { ClimateSummary, LocationClimate, PvgisData, SeasonClimate } from '../types'
import { hourlyPvShape, SUMMER_MONTHS, WINTER_MONTHS } from './solar'

export interface TmyHour {
  'time(UTC)'?: string
  time?: string
  T2m?: number
  'G(h)'?: number
  'Gd(h)'?: number
}

export interface DailyRadHour {
  month: number
  time: string
  'G(i)'?: number
  'Gcs(i)'?: number
  'Gd(i)'?: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function mean(xs: number[]): number {
  if (!xs.length) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = (p / 100) * (s.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return s[lo]
  return s[lo] * (hi - i) + s[hi] * (i - lo)
}

function emptyShapes(): number[][] {
  return Array.from({ length: 13 }, () => new Array(24).fill(0))
}

function normalize(hours: number[]): number[] {
  const sum = hours.reduce((a, b) => a + b, 0)
  if (sum <= 0) return hours
  return hours.map((v) => v / sum)
}

function geometricShapes(lat: number, lon: number, tilt: number, azimuth: number): number[][] {
  const shapes = emptyShapes()
  for (let m = 1; m <= 12; m++) {
    shapes[m] = hourlyPvShape(lat, m, tilt, azimuth, lon)
  }
  return shapes
}

function hourIndex(time: string): number {
  const h = Number.parseInt(time.slice(0, 2), 10)
  return Number.isFinite(h) ? clamp(h, 0, 23) : 0
}

function shapesFromDaily(daily: DailyRadHour[], fallback: number[][]): number[][] {
  const acc = emptyShapes()
  for (const row of daily) {
    const m = Number(row.month)
    if (m < 1 || m > 12) continue
    acc[m][hourIndex(row.time)] += Number(row['G(i)'] ?? 0)
  }
  for (let m = 1; m <= 12; m++) {
    acc[m] = acc[m].some((v) => v > 0) ? normalize(acc[m]) : fallback[m]
  }
  return acc
}

function clearnessFor(daily: DailyRadHour[], months: number[]): number {
  let g = 0
  let cs = 0
  for (const row of daily) {
    if (!months.includes(Number(row.month))) continue
    g += Number(row['G(i)'] ?? 0)
    cs += Number(row['Gcs(i)'] ?? 0)
  }
  if (cs <= 0) return 0.7
  return clamp(g / cs, 0.35, 1)
}

interface DayAgg {
  month: number
  dayOfMonth: number
  ghi: number
  diffuse: number
  temp: number[]
}

function aggregateDays(tmy: TmyHour[]): DayAgg[] {
  const byDay = new Map<string, DayAgg>()
  for (const h of tmy) {
    const stamp = h['time(UTC)'] ?? h.time ?? ''
    if (stamp.length < 8) continue
    const key = stamp.slice(0, 8)
    const month = Number.parseInt(stamp.slice(4, 6), 10)
    const dayOfMonth = Number.parseInt(stamp.slice(6, 8), 10)
    const rec = byDay.get(key) ?? {
      month,
      dayOfMonth,
      ghi: 0,
      diffuse: 0,
      temp: [],
    }
    rec.ghi += Number(h['G(h)'] ?? 0)
    rec.diffuse += Number(h['Gd(h)'] ?? 0)
    rec.temp.push(Number(h.T2m ?? 12))
    byDay.set(key, rec)
  }
  return [...byDay.values()].map((d) => ({
    ...d,
    ghi: d.ghi / 1000,
  }))
}

function cloudySpells(days: DayAgg[], months: number[], threshold: number): number[] {
  const seq: DayAgg[] = []
  for (const month of months) {
    seq.push(
      ...days
        .filter((d) => d.month === month)
        .sort((a, b) => a.dayOfMonth - b.dayOfMonth),
    )
  }
  const spells: number[] = []
  let cur = 0
  for (const d of seq) {
    if (d.ghi < threshold) {
      cur += 1
    } else if (cur) {
      spells.push(cur)
      cur = 0
    }
  }
  if (cur) spells.push(cur)
  return spells
}

function seasonFromDays(
  days: DayAgg[],
  months: number[],
  clearness: number,
): SeasonClimate {
  const selected = days.filter((d) => months.includes(d.month))
  const ghi = selected.map((d) => d.ghi)
  const meanGhi = mean(ghi) || 2.4
  const poor = percentile(ghi, 20) || meanGhi * 0.7
  const threshold = 0.7 * meanGhi
  const cloudyDays = selected.filter((d) => d.ghi < threshold).length
  const spells = cloudySpells(selected, months, threshold)
  const maxSpell = spells.length ? Math.max(...spells) : 1
  const typical = clamp(
    Math.round(Math.max(percentile(spells, 80), cloudyDays >= 12 ? 2 : 1)),
    1,
    3,
  )
  const temps = selected.flatMap((d) => d.temp)
  const gSum = selected.reduce((s, d) => s + d.ghi, 0)
  const dSum = selected.reduce((s, d) => s + d.diffuse / 1000, 0)
  return {
    meanTempC: mean(temps) || 12,
    meanDailyGhiKwhM2: meanGhi,
    poorDayGhiKwhM2: Math.min(poor, meanGhi),
    cloudyDays,
    maxCloudySpellDays: maxSpell,
    typicalSpellDays: typical,
    diffuseRatio: gSum > 0 ? clamp(dSum / gSum, 0.15, 0.95) : 0.45,
    clearness,
  }
}

const LISBON_WINTER: SeasonClimate = {
  meanTempC: 11.1,
  meanDailyGhiKwhM2: 2.61,
  poorDayGhiKwhM2: 1.83,
  cloudyDays: 19,
  maxCloudySpellDays: 4,
  typicalSpellDays: 2,
  diffuseRatio: 0.46,
  clearness: 0.67,
}

const LISBON_SUMMER: SeasonClimate = {
  meanTempC: 20.5,
  meanDailyGhiKwhM2: 6.9,
  poorDayGhiKwhM2: 5.99,
  cloudyDays: 6,
  maxCloudySpellDays: 2,
  typicalSpellDays: 1,
  diffuseRatio: 0.28,
  clearness: 0.86,
}

export function fallbackClimate(lat: number, lon: number, tilt: number, azimuth: number): LocationClimate {
  return {
    source: 'fallback',
    winter: { ...LISBON_WINTER },
    summer: { ...LISBON_SUMMER },
    hourlyShapes: geometricShapes(lat, lon, tilt, azimuth),
  }
}

export function buildClimate(
  tmy: TmyHour[],
  daily: DailyRadHour[],
  lat: number,
  lon: number,
  tilt: number,
  azimuth: number,
): LocationClimate {
  const geo = geometricShapes(lat, lon, tilt, azimuth)
  if (!tmy.length) {
    const climate = fallbackClimate(lat, lon, tilt, azimuth)
    if (daily.length) climate.hourlyShapes = shapesFromDaily(daily, geo)
    return climate
  }
  const days = aggregateDays(tmy)
  return {
    source: 'tmy',
    winter: seasonFromDays(days, WINTER_MONTHS, daily.length ? clearnessFor(daily, WINTER_MONTHS) : 0.67),
    summer: seasonFromDays(days, SUMMER_MONTHS, daily.length ? clearnessFor(daily, SUMMER_MONTHS) : 0.86),
    hourlyShapes: daily.length ? shapesFromDaily(daily, geo) : geo,
  }
}

export function summarizeClimate(climate: LocationClimate): ClimateSummary {
  return {
    source: climate.source,
    winterMeanTempC: climate.winter.meanTempC,
    summerMeanTempC: climate.summer.meanTempC,
    winterMeanDailyGhi: climate.winter.meanDailyGhiKwhM2,
    winterPoorDayGhi: climate.winter.poorDayGhiKwhM2,
    winterCloudyDays: climate.winter.cloudyDays,
    winterTypicalSpellDays: climate.winter.typicalSpellDays,
    winterDiffusePct: climate.winter.diffuseRatio * 100,
    winterClearnessPct: climate.winter.clearness * 100,
  }
}

export function climateShape(
  pvgis: PvgisData,
  month: number,
  lat: number,
  lon: number,
  tilt: number,
  azimuth: number,
): number[] {
  const shape = pvgis.climate.hourlyShapes[month]
  if (shape?.some((v) => v > 0)) return shape
  return hourlyPvShape(lat, month, tilt, azimuth, lon)
}

export function winterClimateShape(
  pvgis: PvgisData,
  lat: number,
  lon: number,
  tilt: number,
  azimuth: number,
): number[] {
  const acc = new Array(24).fill(0)
  for (const month of WINTER_MONTHS) {
    const s = climateShape(pvgis, month, lat, lon, tilt, azimuth)
    for (let h = 0; h < 24; h++) acc[h] += s[h]
  }
  return normalize(acc)
}

export function winterDesignYieldPerKwp(pvgis: PvgisData): number {
  const eds = WINTER_MONTHS.map(
    (m) => pvgis.monthly.find((row) => row.month === m)?.ed ?? 2.8,
  )
  const meanEd = mean(eds) || 2.8
  const winter = pvgis.climate.winter
  const ratio = winter.poorDayGhiKwhM2 / Math.max(0.4, winter.meanDailyGhiKwhM2)
  return Math.max(0.85, meanEd * clamp(ratio, 0.5, 0.92))
}

/** LiFePO4 delivers less usable energy in typical Portuguese winter temperatures. */
export function batteryWinterFactor(pvgis: PvgisData): number {
  const t = pvgis.climate.winter.meanTempC
  return clamp(1 - Math.max(0, 15 - t) * 0.012, 0.82, 1)
}

export function winterSpellExtraDays(pvgis: PvgisData): number {
  return clamp(pvgis.climate.winter.typicalSpellDays - 1, 0, 2)
}
