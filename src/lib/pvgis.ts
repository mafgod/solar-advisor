import type { PvgisData, PvgisMonth } from '../types'
import { buildClimate, fallbackClimate, type DailyRadHour, type TmyHour } from './climate'
import { OPEN_METEO_ARCHIVE } from './endpoints'
import { compassToPvgisAspect } from './geo'

const LISBON_FALLBACK: PvgisMonth[] = [
  { month: 1, ed: 3.04, em: 94.2 },
  { month: 2, ed: 3.68, em: 103.04 },
  { month: 3, ed: 4.25, em: 131.8 },
  { month: 4, ed: 4.72, em: 141.64 },
  { month: 5, ed: 5.14, em: 159.19 },
  { month: 6, ed: 5.27, em: 158.01 },
  { month: 7, ed: 5.59, em: 173.41 },
  { month: 8, ed: 5.53, em: 171.33 },
  { month: 9, ed: 4.97, em: 149.08 },
  { month: 10, ed: 3.81, em: 117.98 },
  { month: 11, ed: 3.01, em: 90.4 },
  { month: 12, ed: 2.8, em: 86.69 },
]

interface PvgisJson {
  outputs?: {
    monthly?: { fixed?: { month: number; E_d: number; E_m: number }[] }
    totals?: { fixed?: { E_y: number } }
    tmy_hourly?: TmyHour[]
    daily_profile?: DailyRadHour[]
  }
  inputs?: {
    mounting_system?: {
      fixed?: {
        slope?: { value: number }
        azimuth?: { value: number }
      }
    }
  }
}

async function fetchJson(path: string, params: Record<string, string>): Promise<PvgisJson> {
  const qs = new URLSearchParams({ outputformat: 'json', ...params })
  const res = await fetch(`/api/pvgis/${path}?${qs.toString()}`)
  if (!res.ok) throw new Error(`PVGIS HTTP ${res.status}`)
  return (await res.json()) as PvgisJson
}

const SYSTEM_PR = 0.86

interface OpenMeteoHourly {
  time: string[]
  shortwave_radiation?: (number | null)[]
  diffuse_radiation?: (number | null)[]
  temperature_2m?: (number | null)[]
  global_tilted_irradiance?: (number | null)[]
}

interface OpenMeteoJson {
  hourly?: OpenMeteoHourly
}

function archiveYear(): number {
  return new Date().getUTCFullYear() - 1
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

async function fetchOpenMeteoYear(
  lat: number,
  lon: number,
  tilt: number,
  pvgisAspect: number,
): Promise<OpenMeteoHourly> {
  const year = archiveYear()
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
    hourly: 'shortwave_radiation,diffuse_radiation,temperature_2m,global_tilted_irradiance',
    tilt: String(tilt),
    azimuth: String(pvgisAspect),
    timezone: 'auto',
  })
  const res = await fetch(`${OPEN_METEO_ARCHIVE}?${qs}`)
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  const json = (await res.json()) as OpenMeteoJson
  if (!json.hourly?.time?.length) throw new Error('Open-Meteo vazio')
  return json.hourly
}

function monthlyFromGti(hourly: OpenMeteoHourly): { yearly: number; monthly: PvgisMonth[] } {
  const gti = hourly.global_tilted_irradiance ?? []
  const acc = Array.from({ length: 13 }, () => ({ kwh: 0, days: new Set<string>() }))
  hourly.time.forEach((stamp, i) => {
    const month = Number.parseInt(stamp.slice(5, 7), 10)
    if (month < 1 || month > 12) return
    acc[month].kwh += (num(gti[i]) / 1000) * SYSTEM_PR
    acc[month].days.add(stamp.slice(0, 10))
  })
  const monthly: PvgisMonth[] = []
  for (let month = 1; month <= 12; month++) {
    const days = Math.max(1, acc[month].days.size)
    monthly.push({ month, em: acc[month].kwh, ed: acc[month].kwh / days })
  }
  return { yearly: monthly.reduce((s, m) => s + m.em, 0), monthly }
}

function tmyFromHourly(hourly: OpenMeteoHourly): TmyHour[] {
  const ghi = hourly.shortwave_radiation ?? []
  const diffuse = hourly.diffuse_radiation ?? []
  const temp = hourly.temperature_2m ?? []
  return hourly.time.map((stamp, i) => {
    const compact = stamp.replace(/[-T:]/g, '').slice(0, 10)
    return {
      'time(UTC)': `${compact.slice(0, 8)}:${compact.slice(8, 10)}`,
      T2m: num(temp[i]),
      'G(h)': num(ghi[i]),
      'Gd(h)': num(diffuse[i]),
    }
  })
}

function dailyFromGti(hourly: OpenMeteoHourly): DailyRadHour[] {
  const gti = hourly.global_tilted_irradiance ?? []
  const sum = Array.from({ length: 13 }, () => new Array(24).fill(0))
  const n = Array.from({ length: 13 }, () => new Array(24).fill(0))
  hourly.time.forEach((stamp, i) => {
    const month = Number.parseInt(stamp.slice(5, 7), 10)
    const hour = Number.parseInt(stamp.slice(11, 13), 10)
    if (month < 1 || month > 12 || hour < 0 || hour > 23) return
    sum[month][hour] += num(gti[i])
    n[month][hour] += 1
  })
  const rows: DailyRadHour[] = []
  for (let month = 1; month <= 12; month++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = n[month][hour]
      if (!count) continue
      rows.push({
        month,
        time: `${String(hour).padStart(2, '0')}:00`,
        'G(i)': sum[month][hour] / count,
      })
    }
  }
  return rows
}

async function loadFromOpenMeteo(
  lat: number,
  lon: number,
  tilt: number,
  compassAzimuth: number,
  useClimate: boolean,
): Promise<PvgisData> {
  const aspect = compassToPvgisAspect(compassAzimuth)
  const optimalTilt = Math.round(Math.min(45, Math.max(20, lat)))
  const climateFallback = fallbackClimate(lat, lon, tilt, compassAzimuth)
  const [oriented, optimal] = await Promise.all([
    fetchOpenMeteoYear(lat, lon, tilt, aspect),
    fetchOpenMeteoYear(lat, lon, optimalTilt, 0),
  ])
  const a = monthlyFromGti(oriented)
  const o = monthlyFromGti(optimal)
  const climate =
    useClimate && oriented.time.length
      ? buildClimate(tmyFromHourly(oriented), dailyFromGti(oriented), lat, lon, tilt, compassAzimuth)
      : climateFallback
  return {
    source: 'openmeteo',
    yearlyKwhPerKwp: a.yearly,
    monthly: a.monthly,
    optimalTilt,
    optimalAzimuthPvgis: 0,
    optimalYearlyKwhPerKwp: o.yearly,
    climate,
  }
}

async function fetchPVcalc(params: Record<string, string>): Promise<PvgisJson> {
  return fetchJson('PVcalc', {
    usehorizon: '1',
    pvcalculation: '1',
    loss: '14',
    peakpower: '1',
    ...params,
  })
}

function parse(json: PvgisJson): { yearly: number; monthly: PvgisMonth[] } {
  const rows = json.outputs?.monthly?.fixed ?? []
  const monthly = rows.map((r) => ({
    month: r.month,
    ed: r.E_d,
    em: r.E_m,
  }))
  const yearly =
    json.outputs?.totals?.fixed?.E_y ??
    monthly.reduce((s, m) => s + m.em, 0)
  return { yearly, monthly }
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

async function loadFromPvgis(
  lat: number,
  lon: number,
  tilt: number,
  compassAzimuth: number,
  useClimate: boolean,
): Promise<PvgisData> {
  const aspect = compassToPvgisAspect(compassAzimuth).toFixed(1)
  const geo = {
    lat: String(lat),
    lon: String(lon),
  }
  const climateFallback = fallbackClimate(lat, lon, tilt, compassAzimuth)
  const jobs: Promise<PvgisJson>[] = [
    fetchPVcalc({
      ...geo,
      angle: String(tilt),
      aspect,
    }),
    fetchPVcalc({
      ...geo,
      optimalangles: '1',
    }),
  ]
  if (useClimate) {
    jobs.push(
      fetchJson('tmy', { ...geo, usehorizon: '1' }),
      fetchJson('DRcalc', {
        ...geo,
        month: '0',
        global: '1',
        clearsky: '1',
        showtemperatures: '1',
        localtime: '1',
        usehorizon: '1',
        angle: String(tilt),
        aspect,
      }),
    )
  }
  const settled = await Promise.allSettled(jobs)
  const oriented = settledValue(settled[0])
  if (!oriented) throw new Error('PVGIS PVcalc failed')

  const a = parse(oriented)
  const optimal = settledValue(settled[1])
  const o = optimal ? parse(optimal) : { yearly: a.yearly, monthly: a.monthly }
  const tmy = useClimate ? settledValue(settled[2])?.outputs?.tmy_hourly ?? [] : []
  const daily = useClimate ? settledValue(settled[3])?.outputs?.daily_profile ?? [] : []
  const climate =
    useClimate && (tmy.length || daily.length)
      ? buildClimate(tmy, daily, lat, lon, tilt, compassAzimuth)
      : climateFallback

  return {
    source: 'pvgis',
    yearlyKwhPerKwp: a.yearly,
    monthly: a.monthly,
    optimalTilt: optimal?.inputs?.mounting_system?.fixed?.slope?.value,
    optimalAzimuthPvgis: optimal?.inputs?.mounting_system?.fixed?.azimuth?.value,
    optimalYearlyKwhPerKwp: o.yearly,
    climate,
  }
}

export async function loadPvgis(
  lat: number,
  lon: number,
  tilt: number,
  compassAzimuth: number,
  opts: { useClimate?: boolean } = {},
): Promise<PvgisData> {
  const useClimate = opts.useClimate !== false
  const climateFallback = fallbackClimate(lat, lon, tilt, compassAzimuth)
  const lisbonFallback = (): PvgisData => ({
    source: 'fallback',
    yearlyKwhPerKwp: 1576.75,
    monthly: LISBON_FALLBACK,
    climate: climateFallback,
  })

  if (!import.meta.env.DEV) {
    try {
      return await loadFromOpenMeteo(lat, lon, tilt, compassAzimuth, useClimate)
    } catch {
      return lisbonFallback()
    }
  }

  try {
    return await loadFromPvgis(lat, lon, tilt, compassAzimuth, useClimate)
  } catch {
    try {
      return await loadFromOpenMeteo(lat, lon, tilt, compassAzimuth, useClimate)
    } catch {
      return lisbonFallback()
    }
  }
}

export function monthEd(data: PvgisData, month: number): number {
  return data.monthly.find((m) => m.month === month)?.ed ?? 3.5
}

export function averageEd(data: PvgisData, months: number[]): number {
  const vals = months.map((m) => monthEd(data, m))
  return vals.reduce((a, b) => a + b, 0) / vals.length
}
