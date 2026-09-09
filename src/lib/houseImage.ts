import { esriExportUrl, esriImageryTileUrl } from './endpoints'
import {
  bboxAround,
  bboxOfPoints,
  effectiveAzimuth,
  polygonAreaM2,
} from './geo'
import type { LocationInput, StudyResult } from '../types'

type BBox = { minLon: number; minLat: number; maxLon: number; maxLat: number }

const VIEW = 1024
const FOOTER = 88
const TILE = 256

function lonToX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z
}

function latToY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
  )
}

function latLonToXy(lat: number, lon: number, bbox: BBox, w: number, h: number): { x: number; y: number } {
  return {
    x: ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * w,
    y: ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * h,
  }
}

function viewBbox(location: LocationInput): BBox {
  const pts = location.zones.flatMap((z) => z.corners)
  const raw = pts.length ? bboxOfPoints(pts, 38) : bboxAround(location.lat, location.lon, 42)
  const midLat = (raw.minLat + raw.maxLat) / 2
  const midLon = (raw.minLon + raw.maxLon) / 2
  const sw = { lat: raw.minLat, lon: raw.minLon }
  const ne = { lat: raw.maxLat, lon: raw.maxLon }
  const halfLatM = Math.max(22, ((ne.lat - sw.lat) * 111_320) / 2)
  const halfLonM = Math.max(
    22,
    ((ne.lon - sw.lon) * 111_320 * Math.cos((midLat * Math.PI) / 180)) / 2,
  )
  return bboxAround(midLat, midLon, Math.max(halfLatM, halfLonM))
}

function pickZoom(bbox: BBox): number {
  for (let z = 19; z >= 15; z--) {
    const x0 = Math.floor(lonToX(bbox.minLon, z))
    const x1 = Math.floor(lonToX(bbox.maxLon, z))
    const y0 = Math.floor(latToY(bbox.maxLat, z))
    const y1 = Math.floor(latToY(bbox.minLat, z))
    const tiles = (x1 - x0 + 1) * (y1 - y0 + 1)
    if (tiles > 0 && tiles <= 25) return z
  }
  return 17
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.size < 80) return null
    const src = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('imagem'))
      img.src = src
    })
    URL.revokeObjectURL(src)
    return img
  } catch {
    return null
  }
}

async function stitchTiles(bbox: BBox): Promise<HTMLCanvasElement | null> {
  const z = pickZoom(bbox)
  const x0 = Math.floor(lonToX(bbox.minLon, z))
  const x1 = Math.floor(lonToX(bbox.maxLon, z))
  const y0 = Math.floor(latToY(bbox.maxLat, z))
  const y1 = Math.floor(latToY(bbox.minLat, z))
  const nx = x1 - x0 + 1
  const ny = y1 - y0 + 1
  if (nx < 1 || ny < 1 || nx * ny > 36) return null

  const mosaic = document.createElement('canvas')
  mosaic.width = nx * TILE
  mosaic.height = ny * TILE
  const ctx = mosaic.getContext('2d')
  if (!ctx) return null

  const tiles = await Promise.all(
    Array.from({ length: nx * ny }, (_, i) => {
      const col = i % nx
      const row = Math.floor(i / nx)
      return loadImage(esriImageryTileUrl(z, y0 + row, x0 + col))
    }),
  )
  if (tiles.every((t) => !t)) return null

  tiles.forEach((img, i) => {
    if (!img) return
    const col = i % nx
    const row = Math.floor(i / nx)
    ctx.drawImage(img, col * TILE, row * TILE)
  })

  const west = lonToX(bbox.minLon, z)
  const east = lonToX(bbox.maxLon, z)
  const north = latToY(bbox.maxLat, z)
  const south = latToY(bbox.minLat, z)
  const sx = (west - x0) * TILE
  const sy = (north - y0) * TILE
  const sw = Math.max(8, (east - west) * TILE)
  const sh = Math.max(8, (south - north) * TILE)

  const out = document.createElement('canvas')
  out.width = VIEW
  out.height = VIEW
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.drawImage(mosaic, sx, sy, sw, sh, 0, 0, VIEW, VIEW)
  return out
}

async function loadExport(bbox: BBox, size: number): Promise<HTMLCanvasElement | null> {
  const img = await loadImage(
    esriExportUrl(`${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`, size),
  )
  if (!img) return null
  const out = document.createElement('canvas')
  out.width = VIEW
  out.height = VIEW
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, VIEW, VIEW)
  return out
}

async function loadSatellite(bbox: BBox): Promise<HTMLCanvasElement> {
  const stitched = await stitchTiles(bbox)
  if (stitched) return stitched
  const exported = (await loadExport(bbox, 768)) ?? (await loadExport(bbox, 384))
  if (exported) return exported
  const fallback = document.createElement('canvas')
  fallback.width = VIEW
  fallback.height = VIEW
  const ctx = fallback.getContext('2d')
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, VIEW, VIEW)
    g.addColorStop(0, '#4d5c4a')
    g.addColorStop(1, '#2a3828')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, VIEW, VIEW)
  }
  return fallback
}

function caption(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  accent: string,
): void {
  ctx.fillStyle = '#0f2744'
  ctx.fillRect(0, VIEW, VIEW, FOOTER)
  ctx.fillStyle = accent
  ctx.fillRect(0, VIEW, VIEW, 3)
  ctx.fillStyle = '#f4f1ea'
  ctx.font = '600 17px Manrope, sans-serif'
  ctx.fillText(lines[0] ?? '', 22, VIEW + 34)
  ctx.font = '13px Manrope, sans-serif'
  ctx.fillStyle = '#c9d6e3'
  ctx.fillText(lines[1] ?? '', 22, VIEW + 58)
  if (lines[2]) {
    ctx.font = '12px Manrope, sans-serif'
    ctx.fillStyle = '#9eb0c2'
    ctx.fillText(lines[2], 22, VIEW + 76)
  }
}

function drawCompass(ctx: CanvasRenderingContext2D, azimuth: number): void {
  const cx = VIEW - 70
  const cy = 70
  ctx.save()
  ctx.translate(cx, cy)
  ctx.fillStyle = 'rgba(15, 39, 68, 0.72)'
  ctx.beginPath()
  ctx.arc(0, 0, 46, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#f4f1ea'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = '#f4f1ea'
  ctx.font = '700 11px Manrope, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('N', 0, -30)
  ctx.fillText('S', 0, 38)
  ctx.fillText('E', 34, 4)
  ctx.fillText('O', -34, 4)
  ctx.rotate((azimuth * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, 24)
  ctx.lineTo(7, 3)
  ctx.lineTo(0, -32)
  ctx.lineTo(-7, 3)
  ctx.closePath()
  ctx.fillStyle = '#c4a574'
  ctx.fill()
  ctx.restore()
}

function drawPanels(
  ctx: CanvasRenderingContext2D,
  location: LocationInput,
  result: StudyResult | null,
  bbox: BBox,
): void {
  const totalArea = Math.max(
    0.01,
    location.zones.reduce((s, z) => s + polygonAreaM2(z.corners), 0),
  )
  const totalPanels = result?.panelCount ?? Math.max(0, Math.round(location.availableAreaM2 / 2.3))
  let panelsLeft = totalPanels

  location.zones.forEach((zone, zi) => {
    const corners = zone.corners.map((p) => latLonToXy(p.lat, p.lon, bbox, VIEW, VIEW))
    ctx.save()
    ctx.beginPath()
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
    ctx.fillStyle = 'rgba(150, 78, 48, 0.32)'
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = '#f4f1ea'
    ctx.stroke()
    ctx.restore()

    if (corners.length < 4) return
    const share = polygonAreaM2(zone.corners) / totalArea
    const n =
      zi === location.zones.length - 1 ? panelsLeft : Math.max(0, Math.round(totalPanels * share))
    panelsLeft -= n
    const cols = Math.max(1, Math.round(Math.sqrt(Math.max(1, n))))
    const rows = Math.max(1, Math.ceil(Math.max(1, n) / cols))
    const compress = Math.cos((Math.max(0, Math.min(80, location.roofTiltDeg)) * Math.PI) / 180)
    let drawn = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (drawn >= n) break
        const u0 = (c + 0.08) / cols
        const u1 = (c + 0.92) / cols
        const v0 = (r + 0.08) / rows
        const v1 = v0 + (0.84 / rows) * compress
        const quad = [
          uv(corners, u0, v0),
          uv(corners, u1, v0),
          uv(corners, u1, v1),
          uv(corners, u0, v1),
        ]
        ctx.beginPath()
        quad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fillStyle = drawn % 2 === 0 ? 'rgba(12, 32, 54, 0.82)' : 'rgba(22, 52, 84, 0.82)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(186, 220, 245, 0.9)'
        ctx.lineWidth = 0.8
        ctx.stroke()
        const lip = [
          uv(corners, u0, v1),
          uv(corners, u1, v1),
          uv(corners, u1, Math.min(1, v1 + (0.04 / rows) * (1 - compress + 0.15))),
          uv(corners, u0, Math.min(1, v1 + (0.04 / rows) * (1 - compress + 0.15))),
        ]
        ctx.beginPath()
        lip.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fillStyle = 'rgba(8, 20, 36, 0.55)'
        ctx.fill()
        drawn += 1
      }
    }
  })
}

function sheet(
  sat: HTMLCanvasElement,
  lines: string[],
  extras?: (ctx: CanvasRenderingContext2D) => void,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = VIEW
  canvas.height = VIEW + FOOTER
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(sat, 0, 0, VIEW, VIEW)
  extras?.(ctx)
  caption(ctx, lines, '#c4a574')
  return canvas.toDataURL('image/jpeg', 0.92)
}

export async function renderHouseViews(
  location: LocationInput,
  result: StudyResult | null,
): Promise<{ house: string; layout: string }> {
  const bbox = viewBbox(location)
  const sat = await loadSatellite(bbox)
  const addr = location.address || 'Habitação'
  const coords = `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`
  const house = sheet(sat, [
    'Habitação — vista aérea',
    `${addr} · ${coords}`,
    `Inclinação ${location.roofTiltDeg}° · ${location.availableAreaM2.toFixed(1)} m² de cobertura marcada`,
  ])
  const rec = result
    ? `${result.panelCount} × ${result.panelWatts} W  ·  ${result.pvKwp.toFixed(2)} kWp  ·  inversor ${result.inverterKw} kW  ·  bateria ${result.batteryKwh} kWh`
    : 'Calcule o estudo para ver a potência recomendada'
  const layout = sheet(
    sat,
    [
      'Implantação dos módulos no telhado',
      rec,
      `${location.zones.length} zona${location.zones.length === 1 ? '' : 's'} · inclinação ${location.roofTiltDeg}° · os painéis seguem as águas desenhadas`,
    ],
    (ctx) => {
      drawPanels(ctx, location, result, bbox)
      drawCompass(ctx, effectiveAzimuth(location))
    },
  )
  return { house, layout }
}

export async function renderHouseImage(
  location: LocationInput,
  result: StudyResult | null,
): Promise<string> {
  const views = await renderHouseViews(location, result)
  return views.layout
}

function uv(pts: { x: number; y: number }[], u: number, v: number): { x: number; y: number } {
  const [a, b, c, d] = pts
  const ab = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
  const dc = { x: d.x + (c.x - d.x) * u, y: d.y + (c.y - d.y) * u }
  return { x: ab.x + (dc.x - ab.x) * v, y: ab.y + (dc.y - ab.y) * v }
}
