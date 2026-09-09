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

/**
 * Perfil relativo (soma = 1) da produção num dia típico do mês,
 * nas horas civis locais da habitação (não UTC nem meio-dia solar).
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
  const slotH = 24 / Math.max(1, steps)
  const hours = new Array<number>(steps).fill(0)

  for (let i = 0; i < steps; i++) {
    const localHour = (i + 0.5) * slotH
    const utcHour = localHour - offsetH
    const hourAngle = (((utcHour - 12) * 15 + lonDeg + eotDeg) * Math.PI) / 180
    const sinEl =
      Math.sin(lat) * Math.sin(decl) +
      Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
    const elev = Math.asin(Math.max(-1, Math.min(1, sinEl)))
    if (elev <= 0.02) continue

    const sinAz =
      (-Math.cos(decl) * Math.sin(hourAngle)) / Math.cos(elev)
    const cosAz =
      (Math.sin(decl) * Math.cos(lat) -
        Math.cos(decl) * Math.sin(lat) * Math.cos(hourAngle)) /
      Math.cos(elev)
    const sunAz = Math.atan2(sinAz, cosAz)

    const cosI =
      Math.sin(elev) * Math.cos(tilt) +
      Math.cos(elev) * Math.sin(tilt) * Math.cos(wrapPi(sunAz - panelAz))
    const beam = Math.max(0, cosI)
    const diffuse = 0.22 * Math.max(0, Math.sin(elev)) * (1 + Math.cos(tilt)) / 2
    hours[i] = beam + diffuse
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

/** Reparte cada hora segundo o perfil a 30 min (nascer/pôr do sol mais suave). */
export function refineHourlyWithShape(hourly24: number[], shape48: number[]): number[] {
  if (hourly24.length === DAY_STEPS) return hourly24
  const out = new Array<number>(DAY_STEPS).fill(0)
  for (let h = 0; h < 24; h++) {
    const e = hourly24[h] ?? 0
    const a = shape48[h * 2] ?? 0
    const b = shape48[h * 2 + 1] ?? 0
    const s = a + b
    if (s <= 0) {
      out[h * 2] = e / 2
      out[h * 2 + 1] = e / 2
    } else {
      out[h * 2] = e * (a / s)
      out[h * 2 + 1] = e * (b / s)
    }
  }
  return out
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

function halfChartPoint<T extends DayChartPoint>(d: T, hour: number, soc: number): T {
  return {
    ...d,
    hour,
    loadKwh: d.loadKwh / 2,
    pvKwh: d.pvKwh / 2,
    socKwh: soc,
    ...(typeof d.gridImportKwh === 'number' ? { gridImportKwh: d.gridImportKwh / 2 } : {}),
    ...(typeof d.exportKwh === 'number' ? { exportKwh: d.exportKwh / 2 } : {}),
    ...(typeof d.batteryKwh === 'number' ? { batteryKwh: d.batteryKwh / 2 } : {}),
  }
}

/** Estudos antigos (24 pontos) passam a 48 intervalos de 30 min para os gráficos. */
export function dayToHalfHours<T extends DayChartPoint>(day: T[]): T[] {
  if (day.length !== 24) return day
  const out: T[] = []
  let prevSoc = day[0]?.socKwh ?? 0
  for (const d of day) {
    out.push(halfChartPoint(d, d.hour, (prevSoc + d.socKwh) / 2))
    out.push(halfChartPoint(d, d.hour + 0.5, d.socKwh))
    prevSoc = d.socKwh
  }
  return out
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
