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
