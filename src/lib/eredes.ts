import * as XLSX from 'xlsx'
import { defaultHourlyProfile } from './sizing'

export interface EredesParseResult {
  hourlyKwh: number[]
  monthlyDailyKwh: number[]
  samples: number
  intervalMinutes: number
  fileName: string
  totalKwh: number
  importDailyKwh: number
  injectionDailyKwh: number
  note: string
}

function toNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  if (raw === '-' || raw === '—') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw instanceof Date) return null
  const s = String(raw)
    .trim()
    .replace(/\s/g, '')
    .replace(/kWh|kW|Wh/gi, '')
    .replace(/\u00a0/g, '')
    .replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function excelDateToJs(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const utc = Date.UTC(1899, 11, 30) + value * 86400000
    return new Date(utc)
  }
  if (typeof value === 'string') {
    const t = value.trim()
    const iso = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    const pt = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
    if (pt) {
      const year = Number(pt[3]) < 100 ? 2000 + Number(pt[3]) : Number(pt[3])
      return new Date(year, Number(pt[2]) - 1, Number(pt[1]))
    }
  }
  return null
}

function parseTime(value: unknown, date: Date | null): { hour: number; minute: number } | null {
  if (value instanceof Date) {
    return { hour: value.getHours(), minute: value.getMinutes() }
  }
  if (typeof value === 'number' && value >= 0 && value < 1.5) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60)
    return { hour: Math.floor(minutes / 60), minute: minutes % 60 }
  }
  if (typeof value === 'string') {
    const m = value.trim().match(/(\d{1,2}):(\d{2})/)
    if (m) return { hour: Number(m[1]) % 24, minute: Number(m[2]) }
  }
  if (date) return { hour: date.getHours(), minute: date.getMinutes() }
  return null
}

function cellText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function isDateHeader(text: string): boolean {
  return /^(data|date)(\b|$)/.test(text) || text.startsWith('data da leitura')
}

function rowsFromWorkbook(buf: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })
  const preferred =
    wb.SheetNames.find((n) => /energia|consumo|diagrama/i.test(n)) ??
    wb.SheetNames.find((n) => /leitura/i.test(n)) ??
    wb.SheetNames[0]
  const sheet = wb.Sheets[preferred]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) as unknown[][]
}

function rowsFromCsv(text: string): unknown[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0)
  const sep = lines.slice(0, 12).some((l) => (l.match(/;/g) ?? []).length > (l.match(/,/g) ?? []).length)
    ? ';'
    : ','
  return lines.map((line) => line.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()))
}

function looksLikeLeituras(rows: unknown[][]): boolean {
  return rows.slice(0, 25).some((row) => {
    const line = row.map(cellText).join(' ')
    return (
      line.includes('tabela de leituras') ||
      line.includes('data da leitura') ||
      line.includes('energia ativa (kwh)')
    )
  })
}

function tariffValorColumns(rows: unknown[][]): number[] {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const labels = rows[i].map(cellText)
    if (!labels.some((c) => c.includes('vazio') || c.includes('ponta') || c.includes('cheias') || c.includes('simples'))) {
      continue
    }
    const sub = (rows[i + 1] ?? []).map(cellText)
    const cols: number[] = []
    labels.forEach((label, c) => {
      if (!/(vazio|ponta|cheias|simples)/.test(label)) return
      if (sub[c] === 'valor') cols.push(c)
      else if (sub[c + 1] === 'valor') cols.push(c + 1)
      else cols.push(c)
    })
    if (cols.length) return cols
  }
  return [5, 7, 9]
}

function findDiagramHeader(rows: unknown[][]): {
  header: number
  dateCol: number
  timeCol: number
  valueCol: number
  injectionCol: number
  isKw: boolean
} | null {
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const row = rows[i].map(cellText)
    if (row.some((c) => c.includes('data da leitura') || c.includes('tabela de leituras'))) continue
    const dateCol = row.findIndex(isDateHeader)
    const timeCol = row.findIndex((c) => /^(hora|time)\b/.test(c) || c === 'hora')
    const registado = row.findIndex((c) => c.includes('consumo registado'))
    const medido = row.findIndex(
      (c) => c.includes('consumo medido') || (c.includes('consumo') && c.includes('ativa') && !c.includes('inje')),
    )
    const generic = row.findIndex((c) => c.includes('consumo') && !c.includes('inje'))
    const valueCol = registado >= 0 ? registado : medido >= 0 ? medido : generic
    const injectionCol = row.findIndex((c) => c.includes('inje') && (c.includes('rede') || c.includes('registada') || c.includes('kw')))
    if (dateCol >= 0 && valueCol >= 0 && dateCol !== valueCol) {
      const label = row[valueCol]
      return {
        header: i,
        dateCol,
        timeCol: timeCol >= 0 ? timeCol : dateCol,
        valueCol,
        injectionCol,
        isKw: /\bkw\b/.test(label) && !/kwh/.test(label),
      }
    }
  }
  return null
}

function summarizeHours(
  points: { ts: number; kwh: number }[],
  intervalMinutes: number,
): { hourlyKwh: number[]; monthlyDailyKwh: number[]; totalKwh: number; days: number } {
  const hourlySum = new Array(24).fill(0)
  const samplesPerHourDay = new Map<string, number>()
  const monthSum = new Array(12).fill(0)
  const monthDays = new Set<string>()
  let totalKwh = 0

  for (const p of points) {
    totalKwh += p.kwh
    const d = new Date(p.ts)
    hourlySum[d.getHours()] += p.kwh
    monthSum[d.getMonth()] += p.kwh
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    monthDays.add(dayKey)
    samplesPerHourDay.set(dayKey, (samplesPerHourDay.get(dayKey) ?? 0) + 1)
  }

  const expected = Math.max(8, Math.round((20 * 60) / Math.max(5, intervalMinutes)))
  const fullDays = [...samplesPerHourDay.values()].filter((n) => n >= expected).length
  const days = Math.max(1, fullDays || samplesPerHourDay.size)
  const hourlyKwh = hourlySum.map((s) => s / days)
  const monthlyDailyKwh = monthSum.map((s, month) => {
    const nd = [...monthDays].filter((k) => k.split('-')[1] === String(month)).length
    return nd ? s / nd : 0
  })
  return { hourlyKwh, monthlyDailyKwh, totalKwh, days }
}

function parseDiagram(rows: unknown[][], fileName: string): EredesParseResult {
  const hdr = findDiagramHeader(rows)
  if (!hdr) {
    throw new Error(
      'Não encontrei as colunas Data / Consumo. No Balcão Digital e-redes use «Consumos» (diagrama de carga) em Excel.',
    )
  }

  const points: { ts: number; consumptionKw: number; injectionKw: number }[] = []
  for (let i = hdr.header + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const date = excelDateToJs(row[hdr.dateCol])
    const time = parseTime(row[hdr.timeCol], hdr.timeCol === hdr.dateCol ? date : null)
    const consumption = toNumber(row[hdr.valueCol])
    if (!date || !time || consumption == null) continue
    const injection =
      hdr.injectionCol >= 0 ? Math.max(0, toNumber(row[hdr.injectionCol]) ?? 0) : 0
    const ts = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      time.hour,
      time.minute,
    ).getTime()
    points.push({ ts, consumptionKw: Math.max(0, consumption), injectionKw: injection })
  }

  if (points.length < 8) {
    throw new Error('O ficheiro não tem amostras suficientes de consumo.')
  }

  points.sort((a, b) => a.ts - b.ts)
  const deltas: number[] = []
  for (let i = 1; i < Math.min(points.length, 80); i++) {
    const d = (points[i].ts - points[i - 1].ts) / 60000
    if (d > 0 && d <= 60) deltas.push(d)
  }
  const intervalMinutes = deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 15
  const factor = hdr.isKw ? intervalMinutes / 60 : 1

  const importOnly = points.filter((p) => p.injectionKw <= 0.001 && p.consumptionKw > 0)
  const baselineKw =
    importOnly.length >= 8
      ? [...importOnly.map((p) => p.consumptionKw)].sort((a, b) => a - b)[
          Math.floor(importOnly.length / 2)
        ]
      : 0

  const hasPv = points.some((p) => p.injectionKw > 0.05)
  const energyPoints = points.map((p) => {
    const usedKw = hasPv && p.injectionKw > 0 ? Math.max(p.consumptionKw, baselineKw) : p.consumptionKw
    return { ts: p.ts, kwh: usedKw * factor, importKwh: p.consumptionKw * factor, injectionKwh: p.injectionKw * factor }
  })

  const profile = summarizeHours(
    energyPoints.map((p) => ({ ts: p.ts, kwh: p.kwh })),
    intervalMinutes,
  )
  const imported = energyPoints.reduce((s, p) => s + p.importKwh, 0)
  const injected = energyPoints.reduce((s, p) => s + p.injectionKwh, 0)
  const importDailyKwh = imported / profile.days
  const injectionDailyKwh = injected / profile.days
  const daily = profile.hourlyKwh.reduce((a, b) => a + b, 0)

  let note = `${fileName}: ${points.length} amostras a ${intervalMinutes} min · perfil médio ${daily.toFixed(2)} kWh/dia`
  if (injectionDailyKwh > 0.2) {
    note += `. Importação da rede ${importDailyKwh.toFixed(2)} kWh/dia e injeção ${injectionDailyKwh.toFixed(1)} kWh/dia — a casa já tem produção FV; o diagrama da e-redes é o da fronteira com a rede, não o consumo interno total.`
  } else {
    note += ` · ${profile.totalKwh.toFixed(0)} kWh no período`
  }

  return {
    hourlyKwh: profile.hourlyKwh,
    monthlyDailyKwh: profile.monthlyDailyKwh,
    samples: points.length,
    intervalMinutes,
    fileName,
    totalKwh: profile.totalKwh,
    importDailyKwh,
    injectionDailyKwh,
    note,
  }
}

function rowKind(row: unknown[]): string {
  const idx = row.findIndex((c) => {
    const t = cellText(c)
    return t.includes('energia consumida') || t.includes('energia injetada')
  })
  return idx >= 0 ? cellText(row[idx]) : ''
}

function sumTariffs(row: unknown[], cols: number[]): number {
  return cols.reduce((s, c) => s + (toNumber(row[c]) ?? 0), 0)
}

function parseLeituras(rows: unknown[][], fileName: string): EredesParseResult {
  const valorCols = tariffValorColumns(rows)
  const readings: { ts: number; consumed: number; injected: number }[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const kind = rowKind(row)
    const date =
      excelDateToJs(row[0]) ??
      (kind.includes('consumida')
        ? (row.map((c) => excelDateToJs(c)).find((d) => d != null) ?? null)
        : null)
    if (!date || !kind.includes('energia consumida')) continue
    const next = rows[i + 1]
    readings.push({
      ts: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
      consumed: sumTariffs(row, valorCols),
      injected: rowKind(next ?? []).includes('injetada') ? sumTariffs(next, valorCols) : 0,
    })
  }

  const unique: typeof readings = []
  const seen = new Set<number>()
  for (const r of readings) {
    if (seen.has(r.ts)) continue
    seen.add(r.ts)
    unique.push(r)
  }
  unique.sort((a, b) => a.ts - b.ts)
  if (unique.length < 2) {
    throw new Error(
      'O ficheiro de Leituras não tem índices suficientes. No Balcão Digital prefira o Excel de Consumos (diagrama de 15 min).',
    )
  }

  const monthSum = new Array(12).fill(0)
  const monthDays = new Array(12).fill(0)
  let consumedKwh = 0
  let injectedKwh = 0
  for (let i = 1; i < unique.length; i++) {
    const days = Math.max(1, Math.round((unique[i].ts - unique[i - 1].ts) / 86400000))
    const dCons = Math.max(0, unique[i].consumed - unique[i - 1].consumed)
    const dInj = Math.max(0, unique[i].injected - unique[i - 1].injected)
    consumedKwh += dCons
    injectedKwh += dInj
    const month = new Date(unique[i].ts).getMonth()
    monthSum[month] += dCons
    monthDays[month] += days
  }

  const spanDays = Math.max(
    1,
    Math.round((unique[unique.length - 1].ts - unique[0].ts) / 86400000),
  )
  const daily = consumedKwh / spanDays
  const hourlyKwh = defaultHourlyProfile(Math.max(daily, 0.05))
  const monthlyDailyKwh = monthSum.map((s, m) => (monthDays[m] ? s / monthDays[m] : 0))
  const importDailyKwh = daily
  const injectionDailyKwh = injectedKwh / spanDays

  let note = `${fileName}: ${unique.length} leituras em ${spanDays} dias · importação média ${importDailyKwh.toFixed(2)} kWh/dia`
  if (injectionDailyKwh > 0.2) {
    note += ` · injeção ${injectionDailyKwh.toFixed(1)} kWh/dia (já existe FV). O perfil horário é sintético a partir das leituras do contador.`
  }

  return {
    hourlyKwh,
    monthlyDailyKwh,
    samples: unique.length,
    intervalMinutes: 1440,
    fileName,
    totalKwh: consumedKwh,
    importDailyKwh,
    injectionDailyKwh,
    note,
  }
}

export async function parseEredesFile(file: File): Promise<EredesParseResult> {
  const name = file.name.toLowerCase()
  const rows =
    name.endsWith('.xlsx') || name.endsWith('.xls')
      ? rowsFromWorkbook(await file.arrayBuffer())
      : rowsFromCsv(await file.text())

  if (/leitura/.test(name) || looksLikeLeituras(rows)) {
    return parseLeituras(rows, file.name)
  }
  if (findDiagramHeader(rows)) {
    return parseDiagram(rows, file.name)
  }
  throw new Error(
    'Não reconheci o Excel da e-redes. Use o ficheiro «Leituras» ou «Consumos» do Balcão Digital.',
  )
}
