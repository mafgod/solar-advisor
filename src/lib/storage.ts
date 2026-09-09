import type { LocationInput, Settings, StudyFile, StudyInput, StudyResult } from '../types'
import { defaultLocation, defaultSettings, defaultStudy, normalizeGoal, normalizeInverterLimit } from './defaults'
import { clampEvChargePower } from './ev'
import { applyZones, roofPolygon } from './geo'

const STUDY_KEY = 'casasolar.study'
const RESULT_KEY = 'casasolar.result'
const SETTINGS_KEY = 'casasolar.settings'
const FILE_KIND = 'casasolar.study' as const
const FILE_VERSION = 1 as const

type LegacyLocation = Partial<LocationInput> & {
  arrayWidthM?: number
  arrayLengthM?: number
  arrayOffsetEastM?: number
  arrayOffsetNorthM?: number
}

function migrateLocation(saved?: LegacyLocation): LocationInput {
  const base = defaultLocation()
  const loc: LocationInput = {
    ...base,
    ...saved,
    zones: Array.isArray(saved?.zones) ? saved.zones : [],
  }
  if (loc.zones.length) return applyZones(loc, loc.zones)
  const widthM = Number(saved?.arrayWidthM)
  const lengthM = Number(saved?.arrayLengthM)
  if (widthM > 1 && lengthM > 1) {
    return applyZones(loc, [
      {
        id: 'z-migrated',
        corners: roofPolygon(
          loc.lat,
          loc.lon,
          widthM,
          lengthM,
          loc.roofAzimuthDeg,
          Number(saved?.arrayOffsetEastM) || 0,
          Number(saved?.arrayOffsetNorthM) || 0,
        ),
        azimuthDeg: loc.roofAzimuthDeg,
      },
    ])
  }
  return { ...loc, zones: [], availableAreaM2: 0 }
}

export function studyFromSaved(
  saved: Partial<StudyInput> & { location?: LegacyLocation },
): StudyInput {
  const base = defaultStudy()
  const consumption = {
    ...base.consumption,
    ...saved.consumption,
    hourlyKwh: saved.consumption?.hourlyKwh ?? base.consumption.hourlyKwh,
    monthlyDailyKwh: saved.consumption?.monthlyDailyKwh ?? base.consumption.monthlyDailyKwh,
    inverterLimitKw: normalizeInverterLimit(saved.consumption?.inverterLimitKw),
  }
  return {
    location: migrateLocation(saved.location),
    consumption,
    ev: {
      ...base.ev,
      ...saved.ev,
      chargeHours: saved.ev?.chargeHours ?? base.ev.chargeHours,
      chargePowerKw: clampEvChargePower(
        typeof saved.ev?.chargePowerKw === 'number' ? saved.ev.chargePowerKw : base.ev.chargePowerKw,
        consumption.phase,
      ),
    },
    goal: normalizeGoal(saved.goal as Record<string, unknown> | undefined),
  }
}

export function loadStudy(): StudyInput {
  try {
    const raw = localStorage.getItem(STUDY_KEY)
    if (!raw) return defaultStudy()
    return studyFromSaved(JSON.parse(raw) as Partial<StudyInput> & { location?: LegacyLocation })
  } catch {
    return defaultStudy()
  }
}

export function saveStudy(study: StudyInput): void {
  localStorage.setItem(STUDY_KEY, JSON.stringify(study))
}

export function loadResult(): StudyResult | null {
  try {
    const raw = localStorage.getItem(RESULT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StudyResult
    return typeof parsed?.pvKwp === 'number' && Array.isArray(parsed.day) ? parsed : null
  } catch {
    return null
  }
}

export function saveResult(result: StudyResult | null): void {
  if (!result) {
    localStorage.removeItem(RESULT_KEY)
    return
  }
  localStorage.setItem(RESULT_KEY, JSON.stringify(result))
}

export function loadSettings(): Settings {
  const env = defaultSettings()
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return env
    const parsed = JSON.parse(raw) as Partial<Settings> & { googleMapsApiKey?: unknown }
    const leaked = typeof parsed.googleMapsApiKey === 'string' && parsed.googleMapsApiKey.length > 0
    delete parsed.googleMapsApiKey
    const next: Settings = {
      amazonTag: parsed.amazonTag ?? env.amazonTag,
      aliexpressAffKey: parsed.aliexpressAffKey ?? env.aliexpressAffKey,
    }
    if (leaked) saveSettings(next)
    return next
  } catch {
    return env
  }
}

export function saveSettings(settings: Settings): void {
  const payload: Settings = {
    amazonTag: settings.amazonTag,
    aliexpressAffKey: settings.aliexpressAffKey,
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload))
}

export function buildStudyFile(input: StudyInput, result: StudyResult | null): StudyFile {
  return {
    kind: FILE_KIND,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    input,
    result,
  }
}

export function parseStudyFile(raw: string): { input: StudyInput; result: StudyResult | null } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('O ficheiro não é JSON válido.')
  }
  if (!data || typeof data !== 'object') throw new Error('Ficheiro de estudo inválido.')
  const obj = data as Record<string, unknown>
  if (obj.kind && obj.kind !== FILE_KIND) {
    throw new Error('Este ficheiro não é um estudo CasaSolar.')
  }
  const payload =
    obj.input && typeof obj.input === 'object'
      ? (obj.input as Partial<StudyInput> & { location?: LegacyLocation })
      : (obj as Partial<StudyInput> & { location?: LegacyLocation })
  if (!payload.location && !payload.consumption) {
    throw new Error('Ficheiro de estudo incompleto.')
  }
  const result =
    obj.result && typeof obj.result === 'object' && typeof (obj.result as StudyResult).pvKwp === 'number'
      ? (obj.result as StudyResult)
      : null
  return { input: studyFromSaved(payload), result }
}

export function studyFileName(input: StudyInput): string {
  const day = new Date().toISOString().slice(0, 10)
  const slug = (input.location.address || 'estudo')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42)
  return `casasolar-${slug || 'estudo'}-${day}.json`
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadStudyFile(input: StudyInput, result: StudyResult | null): void {
  const body = JSON.stringify(buildStudyFile(input, result), null, 2)
  downloadBlob(studyFileName(input), new Blob([body], { type: 'application/json' }))
}
