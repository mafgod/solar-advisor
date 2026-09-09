import type { LocationInput, RoofZone } from '../types'

const M_PER_DEG_LAT = 111_320

export interface LatLon {
  lat: number
  lon: number
}

export function compassLabel(deg: number): string {
  const d = ((deg % 360) + 360) % 360
  const names = [
    'Norte',
    'Nordeste',
    'Este',
    'Sudeste',
    'Sul',
    'Sudoeste',
    'Oeste',
    'Noroeste',
  ]
  return names[Math.round(d / 45) % 8]
}

/** PVGIS: 0 = sul, 90 = oeste, -90 = este, 180 = norte */
export function compassToPvgisAspect(compassDeg: number): number {
  let aspect = compassDeg - 180
  if (aspect > 180) aspect -= 360
  if (aspect < -180) aspect += 360
  return aspect
}

export function metersToLatLon(
  lat: number,
  eastM: number,
  northM: number,
): { dLat: number; dLon: number } {
  return {
    dLat: northM / M_PER_DEG_LAT,
    dLon: eastM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
  }
}

export function destination(
  lat: number,
  lon: number,
  eastM: number,
  northM: number,
): LatLon {
  const { dLat, dLon } = metersToLatLon(lat, eastM, northM)
  return { lat: lat + dLat, lon: lon + dLon }
}

export function metersBetween(a: LatLon, b: LatLon): { east: number; north: number } {
  return {
    north: (b.lat - a.lat) * M_PER_DEG_LAT,
    east: (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180),
  }
}

export function distanceM(a: LatLon, b: LatLon): number {
  const { east, north } = metersBetween(a, b)
  return Math.hypot(east, north)
}

export function roofPolygon(
  lat: number,
  lon: number,
  widthM: number,
  lengthM: number,
  azimuthDeg: number,
  offsetEastM = 0,
  offsetNorthM = 0,
): LatLon[] {
  const origin = destination(lat, lon, offsetEastM, offsetNorthM)
  const az = (azimuthDeg * Math.PI) / 180
  const ridge = az + Math.PI / 2
  const halfW = widthM / 2
  const halfL = lengthM / 2
  const corners = [
    [-halfW, -halfL],
    [halfW, -halfL],
    [halfW, halfL],
    [-halfW, halfL],
  ]
  return corners.map(([alongRidge, alongSlope]) => {
    const east = alongRidge * Math.sin(ridge) + alongSlope * Math.sin(az)
    const north = alongRidge * Math.cos(ridge) + alongSlope * Math.cos(az)
    return destination(origin.lat, origin.lon, east, north)
  })
}

/** Retângulo alinhado ao azimute: o arrasto define o canto oposto. */
export function rectFromDrag(start: LatLon, end: LatLon, azimuthDeg: number): LatLon[] {
  const { east, north } = metersBetween(start, end)
  const az = (azimuthDeg * Math.PI) / 180
  const ridge = az + Math.PI / 2
  const ux = Math.sin(ridge)
  const uy = Math.cos(ridge)
  const vx = Math.sin(az)
  const vy = Math.cos(az)
  const alongRidge = east * ux + north * uy
  const alongSlope = east * vx + north * vy
  const min = 1.8
  const w = Math.sign(alongRidge || 1) * Math.max(Math.abs(alongRidge), min)
  const l = Math.sign(alongSlope || 1) * Math.max(Math.abs(alongSlope), min)
  return [
    start,
    destination(start.lat, start.lon, ux * w, uy * w),
    destination(start.lat, start.lon, ux * w + vx * l, uy * w + vy * l),
    destination(start.lat, start.lon, vx * l, vy * l),
  ]
}

export function polygonAreaM2(corners: LatLon[]): number {
  if (corners.length < 3) return 0
  const origin = corners[0]
  const pts = corners.map((c) => metersBetween(origin, c))
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    s += pts[i].east * pts[j].north - pts[j].east * pts[i].north
  }
  return Math.abs(s) / 2
}

export function pointInPolygon(point: LatLon, corners: LatLon[]): boolean {
  let inside = false
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const yi = corners[i].lat
    const xi = corners[i].lon
    const yj = corners[j].lat
    const xj = corners[j].lon
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function centroid(corners: LatLon[]): LatLon {
  return {
    lat: corners.reduce((s, c) => s + c.lat, 0) / Math.max(1, corners.length),
    lon: corners.reduce((s, c) => s + c.lon, 0) / Math.max(1, corners.length),
  }
}

function slopeAxes(azimuthDeg: number): { vx: number; vy: number; ux: number; uy: number } {
  const az = (azimuthDeg * Math.PI) / 180
  return {
    vx: Math.sin(az),
    vy: Math.cos(az),
    ux: Math.sin(az + Math.PI / 2),
    uy: Math.cos(az + Math.PI / 2),
  }
}

export function tiltPlanCompress(tiltDeg: number): number {
  return Math.cos((Math.max(0, Math.min(80, tiltDeg)) * Math.PI) / 180)
}

/** Filas de módulos na planta: o espaçamento encolhe com a inclinação (vista de cima). */
export function tiltHatchLines(
  corners: LatLon[],
  azimuthDeg: number,
  tiltDeg: number,
): LatLon[][] {
  if (corners.length < 3) return []
  const origin = centroid(corners)
  const { vx, vy, ux, uy } = slopeAxes(azimuthDeg)
  const pts = corners.map((c) => metersBetween(origin, c))
  const sVals = pts.map((p) => p.east * vx + p.north * vy)
  const rVals = pts.map((p) => p.east * ux + p.north * uy)
  const sMin = Math.min(...sVals)
  const sMax = Math.max(...sVals)
  const rMin = Math.min(...rVals)
  const rMax = Math.max(...rVals)
  const spacing = Math.max(0.4, 1.15 * tiltPlanCompress(tiltDeg))
  const pad = Math.min(0.35, (sMax - sMin) * 0.08)
  const lines: LatLon[][] = []
  for (let s = sMin + pad + spacing * 0.35; s <= sMax - pad; s += spacing) {
    lines.push([
      destination(origin.lat, origin.lon, vx * s + ux * rMin, vy * s + uy * rMin),
      destination(origin.lat, origin.lon, vx * s + ux * rMax, vy * s + uy * rMax),
    ])
  }
  return lines
}

/** Seta da cumeeira para o beiral, na direcção da água. */
export function slopeArrow(
  corners: LatLon[],
  azimuthDeg: number,
): { from: LatLon; to: LatLon } | null {
  if (corners.length < 2) return null
  const origin = centroid(corners)
  const { vx, vy } = slopeAxes(azimuthDeg)
  const pts = corners.map((c) => metersBetween(origin, c))
  const sVals = pts.map((p) => p.east * vx + p.north * vy)
  const sMin = Math.min(...sVals)
  const sMax = Math.max(...sVals)
  if (sMax - sMin < 1.2) return null
  return {
    from: destination(origin.lat, origin.lon, vx * sMin, vy * sMin),
    to: destination(origin.lat, origin.lon, vx * sMax, vy * sMax),
  }
}

export function edgeSizes(corners: LatLon[]): { widthM: number; lengthM: number } {
  if (corners.length < 4) return { widthM: 2, lengthM: 2 }
  return {
    widthM: Math.max(1.8, distanceM(corners[0], corners[1])),
    lengthM: Math.max(1.8, distanceM(corners[0], corners[3])),
  }
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Rumo de `from` para `to`, em graus de bússola (0 = norte, 90 = este). */
export function compassBearing(from: LatLon, to: LatLon): number {
  const { east, north } = metersBetween(from, to)
  return normalizeDeg((Math.atan2(east, north) * 180) / Math.PI)
}

export function rotateZone(corners: LatLon[], azimuthDeg: number): LatLon[] {
  const c = centroid(corners)
  const { widthM, lengthM } = edgeSizes(corners)
  return roofPolygon(c.lat, c.lon, widthM, lengthM, normalizeDeg(azimuthDeg))
}

export function translateCorners(corners: LatLon[], from: LatLon, to: LatLon): LatLon[] {
  const { east, north } = metersBetween(from, to)
  return corners.map((c) => destination(c.lat, c.lon, east, north))
}

function ridgeSlopeAxes(azimuthDeg: number): {
  ux: number
  uy: number
  vx: number
  vy: number
} {
  const az = (normalizeDeg(azimuthDeg) * Math.PI) / 180
  const ridge = az + Math.PI / 2
  return {
    ux: Math.sin(ridge),
    uy: Math.cos(ridge),
    vx: Math.sin(az),
    vy: Math.cos(az),
  }
}

/** Aumenta ou reduz o retângulo a partir do centro, mantendo o azimute. */
export function scaleZone(corners: LatLon[], azimuthDeg: number, factor: number): LatLon[] {
  const c = centroid(corners)
  const { widthM, lengthM } = edgeSizes(corners)
  const s = Math.max(0.12, factor)
  return roofPolygon(
    c.lat,
    c.lon,
    Math.max(1.8, widthM * s),
    Math.max(1.8, lengthM * s),
    normalizeDeg(azimuthDeg),
  )
}

/**
 * Arrasta um canto: o lado oposto fica fixo e o retângulo mantém o azimute da água.
 */
export function resizeZoneFromCorner(
  corners: LatLon[],
  cornerIndex: number,
  pointer: LatLon,
  azimuthDeg: number,
): LatLon[] {
  if (corners.length < 4) return corners
  const origin = corners[0]
  const { ux, uy, vx, vy } = ridgeSlopeAxes(azimuthDeg)
  const toUV = (p: LatLon) => {
    const { east, north } = metersBetween(origin, p)
    return { u: east * ux + north * uy, v: east * vx + north * vy }
  }
  const locals = corners.map(toUV)
  const minU = Math.min(...locals.map((p) => p.u))
  const maxU = Math.max(...locals.map((p) => p.u))
  const minV = Math.min(...locals.map((p) => p.v))
  const maxV = Math.max(...locals.map((p) => p.v))
  const corner = locals[Math.max(0, Math.min(corners.length - 1, cornerIndex))]
  const onMinU = Math.abs(corner.u - minU) <= Math.abs(corner.u - maxU)
  const onMinV = Math.abs(corner.v - minV) <= Math.abs(corner.v - maxV)
  const ptr = toUV(pointer)
  let nMinU = onMinU ? ptr.u : minU
  let nMaxU = onMinU ? maxU : ptr.u
  let nMinV = onMinV ? ptr.v : minV
  let nMaxV = onMinV ? maxV : ptr.v
  const minSize = 1.8
  if (nMaxU - nMinU < minSize) {
    if (onMinU) nMinU = nMaxU - minSize
    else nMaxU = nMinU + minSize
  }
  if (nMaxV - nMinV < minSize) {
    if (onMinV) nMinV = nMaxV - minSize
    else nMaxV = nMinV + minSize
  }
  const at = (u: number, v: number) =>
    destination(origin.lat, origin.lon, ux * u + vx * v, uy * u + vy * v)
  return [at(nMinU, nMinV), at(nMaxU, nMinV), at(nMaxU, nMaxV), at(nMinU, nMaxV)]
}

export function rotateHandlePoint(corners: LatLon[], azimuthDeg: number): LatLon {
  const c = centroid(corners)
  const { lengthM } = edgeSizes(corners)
  const dist = Math.max(4, lengthM / 2 + 3)
  const az = (normalizeDeg(azimuthDeg) * Math.PI) / 180
  return destination(c.lat, c.lon, Math.sin(az) * dist, Math.cos(az) * dist)
}

export function bboxAround(
  lat: number,
  lon: number,
  radiusM: number,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const sw = destination(lat, lon, -radiusM, -radiusM)
  const ne = destination(lat, lon, radiusM, radiusM)
  return { minLon: sw.lon, minLat: sw.lat, maxLon: ne.lon, maxLat: ne.lat }
}

export function bboxOfPoints(
  points: LatLon[],
  padM = 14,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  if (!points.length) return bboxAround(0, 0, padM)
  let minLat = points[0].lat
  let maxLat = points[0].lat
  let minLon = points[0].lon
  let maxLon = points[0].lon
  for (const p of points) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLon = Math.min(minLon, p.lon)
    maxLon = Math.max(maxLon, p.lon)
  }
  const midLat = (minLat + maxLat) / 2
  const padLat = padM / M_PER_DEG_LAT
  const padLon = padM / (M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180))
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: minLon - padLon,
    maxLon: maxLon + padLon,
  }
}

export function circularMeanAzimuth(
  items: { azimuthDeg: number; weight: number }[],
): number {
  let s = 0
  let c = 0
  for (const it of items) {
    const r = (it.azimuthDeg * Math.PI) / 180
    s += Math.sin(r) * it.weight
    c += Math.cos(r) * it.weight
  }
  if (s === 0 && c === 0) return 180
  let d = (Math.atan2(s, c) * 180) / Math.PI
  if (d < 0) d += 360
  return d
}

export function zoneAreaTotal(zones: RoofZone[]): number {
  return zones.reduce((s, z) => s + polygonAreaM2(z.corners), 0)
}

export function effectiveAzimuth(location: LocationInput): number {
  const items = location.zones
    .map((z) => ({ azimuthDeg: z.azimuthDeg, weight: polygonAreaM2(z.corners) }))
    .filter((it) => it.weight > 0)
  return items.length ? circularMeanAzimuth(items) : location.roofAzimuthDeg
}

export function applyZones(location: LocationInput, zones: RoofZone[]): LocationInput {
  return {
    ...location,
    zones,
    availableAreaM2: Math.round(zoneAreaTotal(zones) * 10) / 10,
  }
}
