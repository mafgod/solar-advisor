const DAY_OF_YEAR = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

/** Fuso civil da localização (Portugal continental/Madeira vs. Açores). */
export function ianaTimeZone(_lat: number, lon: number): string {
  return lon <= -18.5 ? 'Atlantic/Azores' : 'Europe/Lisbon'
}

/** Atraso do relógio civil face ao UTC, em horas, a meio do mês. */
export function civilOffsetHours(lat: number, lon: number, month: number): number {
  const timeZone = ianaTimeZone(lat, lon)
  const utc = new Date(Date.UTC(2024, Math.max(0, Math.min(11, month - 1)), 15, 12, 0, 0))
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(dtf.formatToParts(utc).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUtc - utc.getTime()) / 3_600_000
}

function equationOfTimeMinutes(dayOfYear: number): number {
  const b = (2 * Math.PI * (dayOfYear - 81)) / 364
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b)
}

export const DAY_STEPS = 48
export const STEP_HOURS = 0.5

function planeIrradiance(
  localHour: number,
  lat: number,
  decl: number,
  tilt: number,
  panelAz: number,
  offsetH: number,
  lonDeg: number,
  eotDeg: number,
): number {
  const utcHour = localHour - offsetH
  const hourAngle = (((utcHour - 12) * 15 + lonDeg + eotDeg) * Math.PI) / 180
  const sinEl =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
  const elev = Math.asin(Math.max(-1, Math.min(1, sinEl)))
  if (elev <= 0) return 0

  const cosEl = Math.cos(elev)
  const sinAz = (-Math.cos(decl) * Math.sin(hourAngle)) / cosEl
  const cosAz =
    (Math.sin(decl) * Math.cos(lat) - Math.cos(decl) * Math.sin(lat) * Math.cos(hourAngle)) /
    cosEl
  const sunAz = Math.atan2(sinAz, cosAz)
  const cosI =
    Math.sin(elev) * Math.cos(tilt) +
    Math.cos(elev) * Math.sin(tilt) * Math.cos(wrapPi(sunAz - panelAz))
  const beam = Math.max(0, cosI)
  const diffuse = 0.22 * Math.sin(elev) * (1 + Math.cos(tilt)) / 2
  return beam + diffuse
}

/**
 * Perfil relativo (soma = 1) da produção num dia típico do mês,
 * nas horas civis locais da habitação (não UTC nem meio-dia solar).
 * Cada intervalo é a média da irradiância ao longo do intervalo, para o
 * nascer e o pôr do sol não caírem a zero num único passo.
 */
export function pvShape(
  latDeg: number,
  month: number,
  tiltDeg: number,
  azimuthCompassDeg: number,
  lonDeg: number,
  steps = 24,
): number[] {
  const n = DAY_OF_YEAR[Math.max(0, Math.min(11, month - 1))]
  const decl = (23.45 * Math.sin((2 * Math.PI * (n - 81)) / 365) * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  const tilt = (tiltDeg * Math.PI) / 180
  const panelAz = (azimuthCompassDeg * Math.PI) / 180
  const offsetH = civilOffsetHours(latDeg, lonDeg, month)
  const eotDeg = equationOfTimeMinutes(n) / 4
  const nSteps = Math.max(1, steps)
  const slotH = 24 / nSteps
  const sub = Math.max(4, Math.round(slotH * 12))
  const hours = new Array<number>(nSteps).fill(0)

  for (let i = 0; i < nSteps; i++) {
    let acc = 0
    for (let s = 0; s < sub; s++) {
      const localHour = (i + (s + 0.5) / sub) * slotH
      acc += planeIrradiance(localHour, lat, decl, tilt, panelAz, offsetH, lonDeg, eotDeg)
    }
    hours[i] = acc / sub
  }

  const sum = hours.reduce((a, b) => a + b, 0)
  if (sum <= 0) return hours
  return hours.map((v) => v / sum)
}

export function hourlyPvShape(
  latDeg: number,
  month: number,
  tiltDeg: number,
  azimuthCompassDeg: number,
  lonDeg: number,
): number[] {
  return pvShape(latDeg, month, tiltDeg, azimuthCompassDeg, lonDeg, 24)
}

export function halfHourPvShape(
  latDeg: number,
  month: number,
  tiltDeg: number,
  azimuthCompassDeg: number,
  lonDeg: number,
): number[] {
  return pvShape(latDeg, month, tiltDeg, azimuthCompassDeg, lonDeg, DAY_STEPS)
}

/** Parte um perfil horário em intervalos de 30 min, conservando a energia de cada hora. */
export function toHalfHourEnergy(hourly: number[]): number[] {
  if (hourly.length === DAY_STEPS) return hourly
  const out = new Array<number>(DAY_STEPS).fill(0)
  if (!hourly.length) return out
  const ratio = DAY_STEPS / hourly.length
  if (!Number.isInteger(ratio) || ratio < 1) {
    for (let i = 0; i < DAY_STEPS; i++) {
      out[i] = (hourly[Math.min(hourly.length - 1, Math.floor((i / DAY_STEPS) * hourly.length))] ?? 0) / ratio
    }
    return out
  }
  for (let h = 0; h < hourly.length; h++) {
    const part = (hourly[h] ?? 0) / ratio
    for (let k = 0; k < ratio; k++) out[h * ratio + k] = part
  }
  return out
}

/**
 * Passa um perfil horário (amostra a meio de cada hora) para 30 min,
 * interpolando entre horas para o pôr do sol não cair a zero no limite da hora.
 */
export function refineHourlyWithShape(hourly24: number[], shape48: number[]): number[] {
  if (hourly24.length === DAY_STEPS) return hourly24
  const out = new Array<number>(DAY_STEPS).fill(0)
  const sampleAt = (hour: number): number => {
    const src = hour - 0.5
    if (src <= 0) return hourly24[0] ?? 0
    if (src >= 23) return hourly24[23] ?? 0
    const i0 = Math.floor(src)
    const f = src - i0
    return (hourly24[i0] ?? 0) * (1 - f) + (hourly24[i0 + 1] ?? 0) * f
  }
  for (let i = 0; i < DAY_STEPS; i++) {
    out[i] = Math.max(0, sampleAt(i * STEP_HOURS + STEP_HOURS / 2))
  }
  const sum = out.reduce((a, b) => a + b, 0)
  if (sum <= 0) return shape48.some((v) => v > 0) ? shape48 : out
  return out.map((v) => v / sum)
}

export function formatDayClock(hour: number): string {
  const total = Math.round(((hour % 24) + 24) * 60) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

type DayChartPoint = {
  hour: number
  loadKwh: number
  pvKwh: number
  socKwh: number
  gridImportKwh?: number
  exportKwh?: number
  batteryKwh?: number
}

function expandDayToHalfHours<T extends DayChartPoint>(day: T[]): T[] {
  if (day.length === DAY_STEPS) return day
  if (day.length !== 24) return day
  const out: T[] = []
  let prevSoc = day[0]?.socKwh ?? 0
  for (const d of day) {
    const h = Math.floor(d.hour)
    out.push({
      ...d,
      hour: h,
      loadKwh: d.loadKwh / 2,
      pvKwh: d.pvKwh / 2,
      socKwh: (prevSoc + d.socKwh) / 2,
      ...(typeof d.gridImportKwh === 'number' ? { gridImportKwh: d.gridImportKwh / 2 } : {}),
      ...(typeof d.exportKwh === 'number' ? { exportKwh: d.exportKwh / 2 } : {}),
      ...(typeof d.batteryKwh === 'number' ? { batteryKwh: d.batteryKwh / 2 } : {}),
    })
    out.push({
      ...d,
      hour: h + 0.5,
      loadKwh: d.loadKwh / 2,
      pvKwh: d.pvKwh / 2,
      socKwh: d.socKwh,
      ...(typeof d.gridImportKwh === 'number' ? { gridImportKwh: d.gridImportKwh / 2 } : {}),
      ...(typeof d.exportKwh === 'number' ? { exportKwh: d.exportKwh / 2 } : {}),
      ...(typeof d.batteryKwh === 'number' ? { batteryKwh: d.batteryKwh / 2 } : {}),
    })
    prevSoc = d.socKwh
  }
  return out
}

/** Energia do intervalo (kWh) → potência média (kW = kWh/h). */
export function slotToKw(kwh: number, stepHours = STEP_HOURS): number {
  return stepHours > 0 ? kwh / stepHours : 0
}

/** 48 pontos a 30 min: consumo, solar, rede e SOC no mesmo passo da simulação. */
export function dayToChartPoints<T extends DayChartPoint>(day: T[]): T[] {
  return expandDayToHalfHours(day)
}

export function scaleShape(shape: number[], dailyKwh: number): number[] {
  return shape.map((v) => v * dailyKwh)
}

export const MONTH_LABELS = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
]

export const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]

export const WINTER_MONTHS = [12, 1, 2]
export const SUMMER_MONTHS = [6, 7, 8]
