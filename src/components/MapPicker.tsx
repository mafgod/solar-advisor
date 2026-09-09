import L from 'leaflet'
import { useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import {
  applyZones,
  centroid,
  compassBearing,
  compassLabel,
  distanceM,
  normalizeDeg,
  pointInPolygon,
  polygonAreaM2,
  rectFromDrag,
  rotateHandlePoint,
  rotateZone,
  scaleZone,
  resizeZoneFromCorner,
  slopeArrow,
  tiltHatchLines,
  translateCorners,
} from '../lib/geo'
import { esriImageryTiles, esriPlacesTiles, photonReverseUrl } from '../lib/endpoints'
import { geocodeAddress, localityFallbackNote, type GeoHit } from '../lib/geocode'
import type { LocationInput, RoofZone } from '../types'

interface Props {
  value: LocationInput
  onChange: (next: LocationInput) => void
  active?: boolean
}

type SavedMapView = { lat: number; lon: number; zoom: number }

let lastMapView: SavedMapView | null = null

interface Suggestion extends GeoHit {}

type MapTool = 'none' | 'pan' | 'draw' | 'resize' | 'rotate' | 'erase'

function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = text
    .trim()
    .replace(/;/g, ',')
    .match(/^(-?\d+(?:[.,]\d+)?)\s*,\s*(-?\d+(?:[.,]\d+)?)$/)
  if (!m) return null
  const a = Number(m[1].replace(',', '.'))
  const b = Number(m[2].replace(',', '.'))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b }
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a }
  return null
}

function formatHint(p: {
  name?: string
  street?: string
  housenumber?: string
  city?: string
  locality?: string
  district?: string
  county?: string
  country?: string
}): string {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ')
  return [street || p.name, p.city || p.locality || p.district || p.county, p.country]
    .filter(Boolean)
    .join(', ')
}

async function geocodeGoogle(text: string): Promise<GeoHit[]> {
  if (!import.meta.env.DEV) return []
  try {
    const res = await fetch(`/api/gmaps/geocode?q=${encodeURIComponent(text)}`)
    if (!res.ok) return []
    const json = (await res.json()) as {
      results?: {
        formatted_address?: string
        geometry?: { location?: { lat: number; lng: number } }
        types?: string[]
      }[]
    }
    return (json.results ?? []).map((r) => {
      const types = r.types ?? []
      const kind: GeoHit['kind'] = types.some((t) =>
        ['street_address', 'premise', 'subpremise'].includes(t),
      )
        ? 'house'
        : types.includes('route')
          ? 'street'
          : 'place'
      return {
        display: r.formatted_address ?? '',
        lat: r.geometry?.location?.lat ?? 0,
        lon: r.geometry?.location?.lng ?? 0,
        kind,
      }
    }).filter((h) => h.display && Number.isFinite(h.lat) && Number.isFinite(h.lon))
  } catch {
    return []
  }
}

async function geocode(
  text: string,
  bias: { lat: number; lon: number },
): Promise<Suggestion[]> {
  const coords = parseCoordinates(text)
  if (coords) {
    return [{ display: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`, ...coords, kind: 'house' }]
  }
  const extra = await geocodeGoogle(text)
  return geocodeAddress(text, bias, extra)
}

function newZoneId(): string {
  return `z-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

const ZONE_STYLE = {
  color: '#fff6e0',
  fillColor: '#e8a317',
  fillOpacity: 0.38,
  weight: 2,
}

function TiltSketch({ deg }: { deg: number }) {
  const t = Math.max(0, Math.min(60, deg))
  const rise = Math.min(36, 64 * Math.tan((t * Math.PI) / 180))
  const x0 = 10
  const y0 = 44
  const x1 = x0 + 64
  const y1 = y0 - rise
  return (
    <svg className="tilt-sketch" viewBox="0 0 88 52" width="88" height="52" aria-hidden="true">
      <line x1={x0} y1={y0} x2={x1} y2={y0} stroke="#cdd5df" strokeWidth="1.5" />
      <polygon
        points={`${x0},${y0} ${x1},${y0} ${x1},${y1}`}
        fill="#e8a31755"
        stroke="#c4a574"
        strokeWidth="1.6"
      />
      <text x={x0 + 22} y={y0 - 6} fontSize="11" fontWeight="700" fill="#0f2744">
        {t}°
      </text>
    </svg>
  )
}

export function MapPicker({ value, onChange, active = true }: Props) {
  const mapEl = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const searchTimer = useRef(0)
  const toolRef = useRef<MapTool>('none')
  const drawingRef = useRef<{
    start: { lat: number; lon: number }
    last: { lat: number; lon: number }
  } | null>(null)
  const rotatingRef = useRef<{
    id: string
    baseCorners: { lat: number; lon: number }[]
    startAzimuth: number
    startBearing: number
    lastAzimuth: number
    last: { lat: number; lon: number }
    start: { lat: number; lon: number }
  } | null>(null)
  const movingRef = useRef<{
    id: string
    baseCorners: { lat: number; lon: number }[]
    start: { lat: number; lon: number }
    last: { lat: number; lon: number }
  } | null>(null)
  const resizingRef = useRef<{
    id: string
    mode: 'corner' | 'scale'
    cornerIndex: number
    baseCorners: { lat: number; lon: number }[]
    azimuth: number
    start: { lat: number; lon: number }
    last: { lat: number; lon: number }
    startDist: number
  } | null>(null)
  const justDrewRef = useRef(false)
  const selectedRef = useRef<string | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  const pointerAbortRef = useRef<AbortController | null>(null)

  const leafletRef = useRef<L.Map | null>(null)
  const leafletGroupRef = useRef<L.LayerGroup | null>(null)
  const leafletPreviewRef = useRef<L.Polygon | null>(null)
  const leafletPreviewHatchRef = useRef<L.Layer[]>([])
  const leafletMarkerRef = useRef<L.CircleMarker | null>(null)

  const googleMapRef = useRef<google.maps.Map | null>(null)
  const googlePolysRef = useRef<google.maps.Polygon[]>([])
  const googlePreviewRef = useRef<google.maps.Polygon | null>(null)
  const googlePreviewHatchRef = useRef<google.maps.Polyline[]>([])
  const googleMarkerRef = useRef<google.maps.Marker | null>(null)
  const googleHandleRef = useRef<google.maps.Marker | null>(null)
  const googleSpokeRef = useRef<google.maps.Polyline | null>(null)
  const googleResizeHandlesRef = useRef<google.maps.Marker[]>([])

  const [engine, setEngine] = useState<'google' | 'leaflet'>('leaflet')
  const [query, setQuery] = useState(value.address)
  const [hints, setHints] = useState<Suggestion[]>([])
  const [mapError, setMapError] = useState('')
  const [searching, setSearching] = useState(false)
  const [tool, setTool] = useState<MapTool>('none')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  toolRef.current = tool
  selectedRef.current = selectedId
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!mapEl.current) return
    let cancelled = false

    async function boot() {
      destroyAll()
      startLeaflet()
      if (!cancelled) setEngine('leaflet')
    }

    void boot()
    return () => {
      cancelled = true
      destroyAll()
    }
  }, [])

  useEffect(() => {
    syncOverlays()
  }, [value.zones, value.lat, value.lon, value.roofTiltDeg, value.roofAzimuthDeg, selectedId, engine, tool])

  useEffect(() => {
    applyToolToMap()
  }, [tool, engine])

  const skipFlyOnMount = useRef(true)
  useEffect(() => {
    if (skipFlyOnMount.current) {
      skipFlyOnMount.current = false
      return
    }
    flyMap(value.lat, value.lon)
  }, [value.lat, value.lon, engine])

  useEffect(() => {
    if (!active) return
    const map = leafletRef.current
    const restore = () => {
      map?.invalidateSize()
      if (map && lastMapView) {
        map.setView([lastMapView.lat, lastMapView.lon], lastMapView.zoom, { animate: false })
      }
    }
    const t1 = window.setTimeout(restore, 40)
    const t2 = window.setTimeout(restore, 280)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [active])

  function destroyAll() {
    pointerAbortRef.current?.abort()
    pointerAbortRef.current = null
    pointerIdRef.current = null
    drawingRef.current = null
    rotatingRef.current = null
    movingRef.current = null
    resizingRef.current = null
    googlePreviewRef.current?.setMap(null)
    googleHandleRef.current?.setMap(null)
    googleSpokeRef.current?.setMap(null)
    googleResizeHandlesRef.current.forEach((m) => m.setMap(null))
    googlePolysRef.current.forEach((p) => p.setMap(null))
    googleMarkerRef.current?.setMap(null)
    googlePreviewRef.current = null
    googleHandleRef.current = null
    googleSpokeRef.current = null
    googleResizeHandlesRef.current = []
    googlePolysRef.current = []
    googleMarkerRef.current = null
    googleMapRef.current = null
    leafletPreviewHatchRef.current.forEach((l) => l.remove())
    leafletPreviewHatchRef.current = []
    googlePreviewHatchRef.current.forEach((p) => p.setMap(null))
    googlePreviewHatchRef.current = []
    leafletRef.current?.remove()
    leafletRef.current = null
    leafletGroupRef.current = null
    leafletPreviewRef.current = null
    leafletMarkerRef.current = null
    if (mapEl.current) mapEl.current.innerHTML = ''
  }

  function rememberLeafletView(map: L.Map) {
    if (!activeRef.current) return
    const size = map.getSize()
    if (size.x < 40 || size.y < 40) return
    const c = map.getCenter()
    lastMapView = { lat: c.lat, lon: c.lng, zoom: map.getZoom() }
  }

  function flyMap(lat: number, lon: number, zoom?: number) {
    const leaflet = leafletRef.current
    if (leaflet) {
      const destZoom = zoom ?? Math.max(leaflet.getZoom(), 17)
      const here = leaflet.getCenter()
      const moved =
        Math.abs(here.lat - lat) > 0.00005 || Math.abs(here.lng - lon) > 0.00005
      if (moved || zoom != null) leaflet.setView([lat, lon], destZoom, { animate: true })
      rememberLeafletView(leaflet)
    }
    const gmap = googleMapRef.current
    if (gmap) {
      const destZoom = zoom ?? Math.max(gmap.getZoom() ?? 17, 17)
      const c = gmap.getCenter()
      const moved =
        !c || Math.abs(c.lat() - lat) > 0.00005 || Math.abs(c.lng() - lon) > 0.00005
      if (moved || zoom != null) {
        gmap.panTo({ lat, lng: lon })
        gmap.setZoom(Math.min(21, destZoom))
      }
    }
  }

  function focusZone(zone: RoofZone) {
    const corners = zone.corners
    if (corners.length < 1) return
    const leaflet = leafletRef.current
    if (leaflet) {
      const bounds = L.latLngBounds(corners.map((c) => [c.lat, c.lon] as [number, number]))
      leaflet.fitBounds(bounds, {
        animate: true,
        maxZoom: Math.max(leaflet.getZoom(), 19),
        padding: [40, 40],
      })
    }
    const gmap = googleMapRef.current
    if (gmap) {
      const bounds = new google.maps.LatLngBounds()
      for (const c of corners) bounds.extend({ lat: c.lat, lng: c.lon })
      gmap.fitBounds(bounds, 48)
    }
  }

  function eventLatLng(ev: MouseEvent): { lat: number; lon: number } | null {
    const map = leafletRef.current
    if (!map) return null
    const ll = map.mouseEventToLatLng(ev)
    return { lat: ll.lat, lon: ll.lng }
  }

  function nearestCornerIndex(
    point: { lat: number; lon: number },
    corners: { lat: number; lon: number }[],
    maxPx = 28,
  ): number | null {
    const map = leafletRef.current
    if (map) {
      const p = map.latLngToContainerPoint([point.lat, point.lon])
      let best = -1
      let bestD = maxPx
      corners.forEach((c, i) => {
        const q = map.latLngToContainerPoint([c.lat, c.lon])
        const d = Math.hypot(p.x - q.x, p.y - q.y)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      return best >= 0 ? best : null
    }
    let best = -1
    let bestD = 6
    corners.forEach((c, i) => {
      const d = distanceM(point, c)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best >= 0 ? best : null
  }

  function capturePointer(ev: PointerEvent) {
    ev.preventDefault()
    pointerIdRef.current = ev.pointerId
    try {
      leafletRef.current?.getContainer().setPointerCapture(ev.pointerId)
    } catch {
      /* Android WebView antigo */
    }
  }

  function onPointerDown(ev: PointerEvent) {
    if (!ev.isPrimary) return
    if (ev.pointerType === 'mouse' && ev.button !== 0) return
    const target = ev.target as HTMLElement | null
    if (target?.closest('.leaflet-control, .map-tools')) return
    const pos = eventLatLng(ev)
    if (!pos) return
    const tool = toolRef.current
    if (tool === 'draw') {
      capturePointer(ev)
      beginDraw(pos.lat, pos.lon)
      return
    }
    if (tool === 'rotate') {
      const zone = hitZone(pos.lat, pos.lon)
      if (!zone) return
      capturePointer(ev)
      beginRotate(zone, pos.lat, pos.lon)
      return
    }
    if (tool === 'resize') {
      const zone = zoneForResize(pos)
      if (!zone) return
      capturePointer(ev)
      beginResize(zone, pos)
      return
    }
    if (tool === 'pan') {
      const zone = zoneAt(pos.lat, pos.lon)
      if (!zone) return
      ev.stopPropagation()
      capturePointer(ev)
      beginMove(zone, pos.lat, pos.lon)
    }
  }

  function onPointerMove(ev: PointerEvent) {
    if (!ev.isPrimary) return
    if (pointerIdRef.current != null && ev.pointerId !== pointerIdRef.current) return
    if (!drawingRef.current && !rotatingRef.current && !movingRef.current && !resizingRef.current) return
    ev.preventDefault()
    const pos = eventLatLng(ev)
    if (!pos) return
    moveDraw(pos.lat, pos.lon)
    moveRotate(pos.lat, pos.lon)
    moveZone(pos.lat, pos.lon)
    moveResize(pos.lat, pos.lon)
  }

  function onPointerUp(ev: PointerEvent) {
    if (pointerIdRef.current != null && ev.pointerId !== pointerIdRef.current) return
    const drawing = drawingRef.current
    const rotating = rotatingRef.current
    const moving = movingRef.current
    const resizing = resizingRef.current
    if (!drawing && !rotating && !moving && !resizing) {
      pointerIdRef.current = null
      return
    }
    const pos =
      eventLatLng(ev) ??
      (drawing
        ? drawing.last
        : rotating
          ? rotating.last
          : moving
            ? moving.last
            : resizing
              ? resizing.last
              : null)
    pointerIdRef.current = null
    if (!pos) return
    endDraw(pos.lat, pos.lon)
    endRotate(pos.lat, pos.lon)
    endMove(pos.lat, pos.lon)
    endResize(pos.lat, pos.lon)
  }

  function bindPointer(map: L.Map) {
    pointerAbortRef.current?.abort()
    const ac = new AbortController()
    pointerAbortRef.current = ac
    const opts: AddEventListenerOptions = { signal: ac.signal, passive: false }
    map.getContainer().addEventListener('pointerdown', onPointerDown, { ...opts, capture: true })
    map.getContainer().addEventListener('lostpointercapture', onPointerUp, opts)
    map.getContainer().addEventListener('dragstart', (e) => e.preventDefault(), opts)
    window.addEventListener('pointermove', onPointerMove, opts)
    window.addEventListener('pointerup', onPointerUp, opts)
    window.addEventListener('pointercancel', onPointerUp, opts)
  }

  function applyToolToMap() {
    const t = toolRef.current
    const lock = t === 'draw' || t === 'rotate' || t === 'resize'
    leafletRef.current?.dragging[lock ? 'disable' : 'enable']()
    leafletRef.current?.boxZoom[lock ? 'disable' : 'enable']()
    leafletRef.current?.doubleClickZoom[lock ? 'disable' : 'enable']()
    leafletRef.current?.touchZoom?.[lock ? 'disable' : 'enable']()
    if (leafletRef.current) {
      const el = leafletRef.current.getContainer()
      el.style.cursor =
        t === 'draw'
          ? 'crosshair'
          : t === 'resize'
            ? 'nwse-resize'
            : t === 'rotate' || t === 'pan' || t === 'none'
              ? 'grab'
              : t === 'erase'
                ? 'pointer'
                : ''
      el.style.touchAction = lock ? 'none' : ''
    }
    googleMapRef.current?.setOptions({
      draggable: !lock,
      disableDoubleClickZoom: lock,
      gestureHandling: lock ? 'none' : 'greedy',
      draggableCursor:
        t === 'draw'
          ? 'crosshair'
          : t === 'resize'
            ? 'nwse-resize'
            : t === 'rotate' || t === 'pan' || t === 'none'
              ? 'grab'
              : t === 'erase'
                ? 'pointer'
                : undefined,
    })
  }

  function startLeaflet() {
    if (!mapEl.current) return
    const loc = valueRef.current
    const saved = lastMapView
    const useSaved = Boolean(saved && distanceM(saved, { lat: loc.lat, lon: loc.lon }) < 2500)
    const map = L.map(mapEl.current, {
      zoomControl: true,
      dragging: false,
      boxZoom: false,
      doubleClickZoom: false,
      tapHold: false,
    }).setView(
      useSaved && saved ? [saved.lat, saved.lon] : [loc.lat, loc.lon],
      useSaved && saved ? saved.zoom : 19,
    )
    L.tileLayer(esriImageryTiles, {
      maxZoom: 19,
      attribution: 'Tiles © Esri',
    }).addTo(map)
    L.tileLayer(esriPlacesTiles, {
      maxZoom: 19,
    }).addTo(map)
    leafletGroupRef.current = L.layerGroup().addTo(map)
    map.on('click', (e: L.LeafletMouseEvent) => {
      onMapClick(e.latlng.lat, e.latlng.lng)
    })
    map.on('moveend', () => rememberLeafletView(map))
    map.on('zoomend', () => rememberLeafletView(map))
    leafletRef.current = map
    bindPointer(map)
    syncOverlays()
    if (!useSaved && loc.zones.length) {
      const bounds = L.latLngBounds(
        loc.zones.flatMap((z) => z.corners.map((c) => [c.lat, c.lon] as [number, number])),
      )
      if (bounds.isValid()) {
        map.fitBounds(bounds, { animate: false, maxZoom: 19, padding: [48, 48] })
      }
    }
    setTimeout(() => map.invalidateSize(), 80)
    setTimeout(() => map.invalidateSize(), 400)
    applyToolToMap()
  }

  function beginDraw(lat: number, lon: number) {
    drawingRef.current = { start: { lat, lon }, last: { lat, lon } }
  }

  function moveDraw(lat: number, lon: number) {
    const drawing = drawingRef.current
    if (!drawing) return
    drawing.last = { lat, lon }
    const corners = rectFromDrag(drawing.start, { lat, lon }, valueRef.current.roofAzimuthDeg)
    showPreview(corners)
  }

  function endDraw(lat: number, lon: number) {
    const drawing = drawingRef.current
    if (!drawing) return
    drawingRef.current = null
    hidePreview()
    if (distanceM(drawing.start, { lat, lon }) < 1.5) return
    const corners = rectFromDrag(
      drawing.start,
      { lat, lon },
      valueRef.current.roofAzimuthDeg,
    )
    const zone: RoofZone = {
      id: newZoneId(),
      corners,
      azimuthDeg: valueRef.current.roofAzimuthDeg,
    }
    const zones = [...valueRef.current.zones, zone]
    onChangeRef.current(applyZones(valueRef.current, zones))
    setSelectedId(zone.id)
    justDrewRef.current = true
    window.setTimeout(() => {
      justDrewRef.current = false
    }, 250)
  }

  function zoneAt(lat: number, lon: number): RoofZone | undefined {
    return [...valueRef.current.zones]
      .reverse()
      .find((z) => pointInPolygon({ lat, lon }, z.corners))
  }

  function hitZone(lat: number, lon: number): RoofZone | undefined {
    return zoneAt(lat, lon) ?? valueRef.current.zones.find((z) => z.id === selectedRef.current)
  }

  function beginMove(zone: RoofZone, lat: number, lon: number) {
    movingRef.current = {
      id: zone.id,
      baseCorners: zone.corners.map((c) => ({ ...c })),
      start: { lat, lon },
      last: { lat, lon },
    }
    setSelectedId(zone.id)
    leafletRef.current?.dragging.disable()
    googleMapRef.current?.setOptions({ draggable: false, gestureHandling: 'none' })
    if (leafletRef.current) leafletRef.current.getContainer().style.cursor = 'grabbing'
  }

  function moveZone(lat: number, lon: number) {
    const moving = movingRef.current
    if (!moving) return
    moving.last = { lat, lon }
    showPreview(translateCorners(moving.baseCorners, moving.start, { lat, lon }))
  }

  function endMove(lat: number, lon: number) {
    const moving = movingRef.current
    if (!moving) return
    movingRef.current = null
    hidePreview()
    applyToolToMap()
    const dest = distanceM(moving.start, { lat, lon }) < 1.5 ? moving.last : { lat, lon }
    if (distanceM(moving.start, dest) < 1.5) return
    const corners = translateCorners(moving.baseCorners, moving.start, dest)
    const loc = valueRef.current
    const zones = loc.zones.map((z) => (z.id === moving.id ? { ...z, corners } : z))
    onChangeRef.current(applyZones(loc, zones))
    justDrewRef.current = true
    window.setTimeout(() => {
      justDrewRef.current = false
    }, 250)
  }

  function zoneForResize(pos: { lat: number; lon: number }): RoofZone | undefined {
    const zones = valueRef.current.zones
    const selected = zones.find((z) => z.id === selectedRef.current)
    const ordered = selected
      ? [selected, ...zones.filter((z) => z.id !== selected.id)]
      : [...zones].reverse()
    for (const z of ordered) {
      if (nearestCornerIndex(pos, z.corners) != null) return z
    }
    return zoneAt(pos.lat, pos.lon) ?? selected
  }

  function beginResize(
    zone: RoofZone,
    pos: { lat: number; lon: number },
    cornerIndex?: number | null,
  ) {
    const corner = cornerIndex ?? nearestCornerIndex(pos, zone.corners)
    const center = centroid(zone.corners)
    resizingRef.current = {
      id: zone.id,
      mode: corner != null ? 'corner' : 'scale',
      cornerIndex: corner ?? 0,
      baseCorners: zone.corners.map((c) => ({ ...c })),
      azimuth: zone.azimuthDeg,
      start: { ...pos },
      last: { ...pos },
      startDist: Math.max(0.4, distanceM(center, pos)),
    }
    setSelectedId(zone.id)
    leafletRef.current?.dragging.disable()
    googleMapRef.current?.setOptions({ draggable: false, gestureHandling: 'none' })
    if (leafletRef.current) leafletRef.current.getContainer().style.cursor = 'nwse-resize'
  }

  function resizedPreview(
    resizing: NonNullable<(typeof resizingRef)['current']>,
    pos: { lat: number; lon: number },
  ) {
    if (resizing.mode === 'corner') {
      return resizeZoneFromCorner(
        resizing.baseCorners,
        resizing.cornerIndex,
        pos,
        resizing.azimuth,
      )
    }
    const center = centroid(resizing.baseCorners)
    return scaleZone(
      resizing.baseCorners,
      resizing.azimuth,
      distanceM(center, pos) / resizing.startDist,
    )
  }

  function moveResize(lat: number, lon: number) {
    const resizing = resizingRef.current
    if (!resizing) return
    resizing.last = { lat, lon }
    showPreview(resizedPreview(resizing, { lat, lon }))
  }

  function endResize(lat: number, lon: number) {
    const resizing = resizingRef.current
    if (!resizing) return
    resizingRef.current = null
    hidePreview()
    applyToolToMap()
    const dest = distanceM(resizing.start, { lat, lon }) < 0.8 ? resizing.last : { lat, lon }
    if (distanceM(resizing.start, dest) < 0.8) return
    const corners = resizedPreview(resizing, dest)
    const loc = valueRef.current
    const zones = loc.zones.map((z) => (z.id === resizing.id ? { ...z, corners } : z))
    onChangeRef.current(applyZones(loc, zones))
    justDrewRef.current = true
    window.setTimeout(() => {
      justDrewRef.current = false
    }, 250)
  }

  function beginRotate(zone: RoofZone, lat: number, lon: number) {
    const center = centroid(zone.corners)
    rotatingRef.current = {
      id: zone.id,
      baseCorners: zone.corners.map((c) => ({ ...c })),
      startAzimuth: zone.azimuthDeg,
      startBearing: compassBearing(center, { lat, lon }),
      lastAzimuth: zone.azimuthDeg,
      last: { lat, lon },
      start: { lat, lon },
    }
    setSelectedId(zone.id)
    leafletRef.current?.dragging.disable()
    googleMapRef.current?.setOptions({ draggable: false, gestureHandling: 'none' })
    if (leafletRef.current) leafletRef.current.getContainer().style.cursor = 'grabbing'
  }

  function moveRotate(lat: number, lon: number) {
    const rotating = rotatingRef.current
    if (!rotating) return
    rotating.last = { lat, lon }
    const center = centroid(rotating.baseCorners)
    if (distanceM(center, { lat, lon }) < 2) return
    const bearing = compassBearing(center, { lat, lon })
    const azimuth = normalizeDeg(rotating.startAzimuth + (bearing - rotating.startBearing))
    rotating.lastAzimuth = azimuth
    showPreview(rotateZone(rotating.baseCorners, azimuth))
  }

  function endRotate(lat: number, lon: number) {
    const rotating = rotatingRef.current
    if (!rotating) return
    rotatingRef.current = null
    hidePreview()
    applyToolToMap()
    if (distanceM(rotating.start, { lat, lon }) < 2) return
    const center = centroid(rotating.baseCorners)
    const mouse = distanceM(center, { lat, lon }) < 2 ? rotating.last : { lat, lon }
    const bearing = compassBearing(center, mouse)
    const azimuth = normalizeDeg(rotating.startAzimuth + (bearing - rotating.startBearing))
    const corners = rotateZone(rotating.baseCorners, azimuth)
    const loc = valueRef.current
    const zones = loc.zones.map((z) =>
      z.id === rotating.id ? { ...z, azimuthDeg: azimuth, corners } : z,
    )
    onChangeRef.current(applyZones({ ...loc, roofAzimuthDeg: azimuth }, zones))
    justDrewRef.current = true
    window.setTimeout(() => {
      justDrewRef.current = false
    }, 250)
  }

  function paintTiltCues(
    corners: { lat: number; lon: number }[],
    azimuthDeg: number,
    into: 'group' | 'preview',
  ) {
    const tilt = valueRef.current.roofTiltDeg
    const hatches = tiltHatchLines(corners, azimuthDeg, tilt)
    const arrow = slopeArrow(corners, azimuthDeg)
    const hatchStyle = {
      color: '#fff8ea',
      weight: 1.4,
      opacity: 0.7,
      interactive: false as const,
    }
    if (leafletRef.current) {
      const add = (layer: L.Layer) => {
        if (into === 'group') leafletGroupRef.current?.addLayer(layer)
        else {
          layer.addTo(leafletRef.current!)
          leafletPreviewHatchRef.current.push(layer)
        }
      }
      for (const line of hatches) {
        add(
          L.polyline(
            line.map((p) => [p.lat, p.lon] as [number, number]),
            hatchStyle,
          ),
        )
      }
      if (arrow) {
        add(
          L.polyline(
            [
              [arrow.from.lat, arrow.from.lon],
              [arrow.to.lat, arrow.to.lon],
            ],
            {
              color: '#0f2744',
              weight: 2.4,
              opacity: 0.9,
              interactive: false,
            },
          ),
        )
        add(
          L.circleMarker([arrow.to.lat, arrow.to.lon], {
            radius: 4,
            color: '#0f2744',
            fillColor: '#f4f1ea',
            fillOpacity: 1,
            weight: 2,
            interactive: false,
          }),
        )
      }
    }
    if (googleMapRef.current) {
      const addG = (poly: google.maps.Polyline) => {
        if (into === 'preview') googlePreviewHatchRef.current.push(poly)
        else googlePolysRef.current.push(poly as unknown as google.maps.Polygon)
      }
      for (const line of hatches) {
        const poly = new google.maps.Polyline({
          path: line.map((p) => ({ lat: p.lat, lng: p.lon })),
          strokeColor: '#fff8ea',
          strokeWeight: 1.4,
          strokeOpacity: 0.7,
          clickable: false,
          map: googleMapRef.current,
        })
        addG(poly)
      }
    }
  }

  function showPreview(corners: { lat: number; lon: number }[]) {
    const latlngs = corners.map((p) => [p.lat, p.lon] as [number, number])
    if (leafletRef.current) {
      if (!leafletPreviewRef.current) {
        leafletPreviewRef.current = L.polygon(latlngs, {
          ...ZONE_STYLE,
          dashArray: '6 4',
          fillOpacity: 0.22,
        }).addTo(leafletRef.current)
      } else {
        leafletPreviewRef.current.setLatLngs(latlngs)
      }
      leafletPreviewHatchRef.current.forEach((l) => l.remove())
      leafletPreviewHatchRef.current = []
      paintTiltCues(corners, valueRef.current.roofAzimuthDeg, 'preview')
    }
    if (googleMapRef.current) {
      const path = corners.map((p) => ({ lat: p.lat, lng: p.lon }))
      if (!googlePreviewRef.current) {
        googlePreviewRef.current = new google.maps.Polygon({
          paths: path,
          strokeColor: '#fff6e0',
          strokeOpacity: 1,
          strokeWeight: 2,
          fillColor: '#e8a317',
          fillOpacity: 0.22,
          map: googleMapRef.current,
          clickable: false,
        })
      } else {
        googlePreviewRef.current.setPath(path)
      }
      googlePreviewHatchRef.current.forEach((p) => p.setMap(null))
      googlePreviewHatchRef.current = []
      paintTiltCues(corners, valueRef.current.roofAzimuthDeg, 'preview')
    }
  }

  function hidePreview() {
    leafletPreviewRef.current?.remove()
    leafletPreviewRef.current = null
    leafletPreviewHatchRef.current.forEach((l) => l.remove())
    leafletPreviewHatchRef.current = []
    googlePreviewRef.current?.setMap(null)
    googlePreviewRef.current = null
    googlePreviewHatchRef.current.forEach((p) => p.setMap(null))
    googlePreviewHatchRef.current = []
  }

  function onMapClick(lat: number, lon: number) {
    if (justDrewRef.current) return
    if (toolRef.current === 'draw' || toolRef.current === 'rotate' || toolRef.current === 'resize') return
    if (toolRef.current === 'erase') {
      const hit = [...valueRef.current.zones]
        .reverse()
        .find((z) => pointInPolygon({ lat, lon }, z.corners))
      if (hit) removeZone(hit.id)
      return
    }
    if (toolRef.current === 'pan') {
      const hit = zoneAt(lat, lon)
      if (hit) {
        setSelectedId(hit.id)
        return
      }
    }
    void reverse(lat, lon).then((address) => goTo(lat, lon, address))
  }

  function syncOverlays() {
    const v = valueRef.current
    if (leafletRef.current && leafletMarkerRef.current == null) {
      leafletMarkerRef.current = L.circleMarker([v.lat, v.lon], {
        radius: 6,
        color: '#fff',
        fillColor: '#1c1917',
        fillOpacity: 1,
        weight: 2,
      }).addTo(leafletRef.current)
    } else {
      leafletMarkerRef.current?.setLatLng([v.lat, v.lon])
    }
    if (googleMapRef.current) {
      if (!googleMarkerRef.current) {
        googleMarkerRef.current = new google.maps.Marker({
          position: { lat: v.lat, lng: v.lon },
          map: googleMapRef.current,
          title: 'Habitação',
        })
      } else {
        googleMarkerRef.current.setPosition({ lat: v.lat, lng: v.lon })
      }
    }

    leafletGroupRef.current?.clearLayers()
    googlePolysRef.current.forEach((p) => p.setMap(null))
    googlePolysRef.current = []
    googleHandleRef.current?.setMap(null)
    googleHandleRef.current = null
    googleSpokeRef.current?.setMap(null)
    googleSpokeRef.current = null
    googleResizeHandlesRef.current.forEach((m) => m.setMap(null))
    googleResizeHandlesRef.current = []

    for (const zone of v.zones) {
      const selected = zone.id === selectedRef.current
      const latlngs = zone.corners.map((p) => [p.lat, p.lon] as [number, number])
      const area = polygonAreaM2(zone.corners)
      const interactive = toolRef.current !== 'draw'
      if (leafletGroupRef.current) {
        const poly = L.polygon(latlngs, {
          ...ZONE_STYLE,
          color: selected ? '#f59e0b' : '#fff6e0',
          weight: selected ? 3 : 2,
          fillOpacity: selected ? 0.5 : 0.38,
          interactive,
        })
        poly.bindTooltip(`${area.toFixed(1)} m² · ${Math.round(v.roofTiltDeg)}°`, { sticky: true })
        poly.on('mousedown', (e) => {
          if (toolRef.current === 'rotate') {
            L.DomEvent.stop(e)
            beginRotate(zone, e.latlng.lat, e.latlng.lng)
            return
          }
          if (toolRef.current === 'resize') {
            L.DomEvent.stop(e)
            beginResize(zone, { lat: e.latlng.lat, lon: e.latlng.lng })
          }
        })
        poly.on('click', (e) => {
          L.DomEvent.stop(e)
          if (toolRef.current === 'draw' || toolRef.current === 'rotate' || toolRef.current === 'resize') return
          if (toolRef.current === 'erase') removeZone(zone.id)
          else setSelectedId(zone.id)
        })
        poly.addTo(leafletGroupRef.current)
        paintTiltCues(zone.corners, zone.azimuthDeg, 'group')
      }
      if (googleMapRef.current) {
        const gpoly = new google.maps.Polygon({
          paths: zone.corners.map((p) => ({ lat: p.lat, lng: p.lon })),
          strokeColor: selected ? '#f59e0b' : '#fff6e0',
          strokeWeight: selected ? 3 : 2,
          fillColor: '#e8a317',
          fillOpacity: selected ? 0.5 : 0.38,
          map: googleMapRef.current,
          clickable: interactive,
        })
        gpoly.addListener('mousedown', (ev: google.maps.MapMouseEvent) => {
          if (!ev.latLng) return
          if (toolRef.current === 'rotate') {
            ev.domEvent?.stopPropagation()
            ev.stop?.()
            beginRotate(zone, ev.latLng.lat(), ev.latLng.lng())
            return
          }
          if (toolRef.current === 'resize') {
            ev.domEvent?.stopPropagation()
            ev.stop?.()
            beginResize(zone, { lat: ev.latLng.lat(), lon: ev.latLng.lng() })
          }
        })
        gpoly.addListener('click', (ev: google.maps.MapMouseEvent) => {
          ev.domEvent?.stopPropagation()
          ev.stop?.()
          if (toolRef.current === 'draw' || toolRef.current === 'rotate' || toolRef.current === 'resize') return
          if (toolRef.current === 'erase') removeZone(zone.id)
          else setSelectedId(zone.id)
        })
        googlePolysRef.current.push(gpoly)
      }
      if (selected && toolRef.current === 'rotate') {
        addRotateHandle(zone)
      }
      if (selected && toolRef.current === 'resize') {
        addResizeHandles(zone)
      }
    }
  }

  function addRotateHandle(zone: RoofZone) {
    const center = centroid(zone.corners)
    const handle = rotateHandlePoint(zone.corners, zone.azimuthDeg)
    if (leafletGroupRef.current) {
      L.polyline(
        [
          [center.lat, center.lon],
          [handle.lat, handle.lon],
        ],
        { color: '#fef3c7', weight: 2, dashArray: '4 3', interactive: false },
      ).addTo(leafletGroupRef.current)
      const marker = L.marker([handle.lat, handle.lon], {
        icon: L.divIcon({
          className: 'rotate-handle',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        interactive: true,
        zIndexOffset: 800,
      })
      marker.on('mousedown', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stop(e)
        e.originalEvent.preventDefault()
        beginRotate(zone, e.latlng.lat, e.latlng.lng)
      })
      marker.on('click', L.DomEvent.stop)
      marker.addTo(leafletGroupRef.current)
    }
    if (googleMapRef.current) {
      googleSpokeRef.current = new google.maps.Polyline({
        path: [
          { lat: center.lat, lng: center.lon },
          { lat: handle.lat, lng: handle.lon },
        ],
        strokeColor: '#fef3c7',
        strokeWeight: 2,
        strokeOpacity: 1,
        clickable: false,
        map: googleMapRef.current,
      })
      googleHandleRef.current = new google.maps.Marker({
        position: { lat: handle.lat, lng: handle.lon },
        map: googleMapRef.current,
        clickable: true,
        draggable: false,
        zIndex: 999,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#fef3c7',
          fillOpacity: 1,
          strokeColor: '#1c1917',
          strokeWeight: 2,
        },
        title: 'Rodar zona',
      })
      googleHandleRef.current.addListener('mousedown', (ev: google.maps.MapMouseEvent) => {
        ev.domEvent?.stopPropagation()
        ev.stop?.()
        const lat = ev.latLng?.lat() ?? handle.lat
        const lon = ev.latLng?.lng() ?? handle.lon
        beginRotate(zone, lat, lon)
      })
    }
  }

  function addResizeHandles(zone: RoofZone) {
    zone.corners.forEach((corner, i) => {
      if (leafletGroupRef.current) {
        const marker = L.marker([corner.lat, corner.lon], {
          icon: L.divIcon({
            className: 'resize-handle',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          interactive: true,
          zIndexOffset: 850,
        })
        marker.on('mousedown', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stop(e)
          e.originalEvent.preventDefault()
          beginResize(zone, { lat: e.latlng.lat, lon: e.latlng.lng }, i)
        })
        marker.on('click', L.DomEvent.stop)
        marker.addTo(leafletGroupRef.current)
      }
      if (googleMapRef.current) {
        const handle = new google.maps.Marker({
          position: { lat: corner.lat, lng: corner.lon },
          map: googleMapRef.current,
          clickable: true,
          draggable: false,
          zIndex: 1000,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: '#ffffff',
            fillOpacity: 1,
            strokeColor: '#0f2744',
            strokeWeight: 2,
          },
          title: 'Ajustar tamanho',
        })
        handle.addListener('mousedown', (ev: google.maps.MapMouseEvent) => {
          ev.domEvent?.stopPropagation()
          ev.stop?.()
          const lat = ev.latLng?.lat() ?? corner.lat
          const lon = ev.latLng?.lng() ?? corner.lon
          beginResize(zone, { lat, lon }, i)
        })
        googleResizeHandlesRef.current.push(handle)
      }
    })
  }

  async function reverse(lat: number, lon: number): Promise<string> {
    try {
      const res = await fetch(photonReverseUrl(lat, lon))
      const json = (await res.json()) as {
        features?: {
          properties?: {
            name?: string
            street?: string
            housenumber?: string
            city?: string
            locality?: string
            district?: string
            county?: string
            country?: string
          }
        }[]
      }
      const p = json.features?.[0]?.properties
      if (!p) return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
      return formatHint(p)
    } catch {
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
    }
  }

  function goTo(lat: number, lon: number, address: string, zoom = 18) {
    setQuery(address)
    setHints([])
    const prev = valueRef.current
    const far = distanceM({ lat: prev.lat, lon: prev.lon }, { lat, lon }) > 150
    onChangeRef.current({
      ...prev,
      lat,
      lon,
      address,
      zones: far ? [] : prev.zones,
      availableAreaM2: far ? 0 : prev.availableAreaM2,
    })
    if (far) setSelectedId(null)
    flyMap(lat, lon, zoom)
  }

  function onQueryChange(text: string) {
    setQuery(text)
    window.clearTimeout(searchTimer.current)
    if (text.trim().length < 3) {
      setHints([])
      return
    }
    searchTimer.current = window.setTimeout(() => {
      void geocode(text, { lat: valueRef.current.lat, lon: valueRef.current.lon }).then(
        setHints,
      )
    }, 280)
  }

  async function commitSearch(text?: string) {
    const q = (text ?? searchRef.current?.value ?? query).trim()
    if (q.length < 3) return
    setSearching(true)
    try {
      const found = await geocode(q, { lat: valueRef.current.lat, lon: valueRef.current.lon })
      const pick = found[0]
      if (!pick) {
        setMapError(
          'Não encontrei essa morada. Escreva a localidade (ex.: Vila Franca do Rosário) ou coordenadas (lat, lon).',
        )
        setHints([])
        return
      }
      const note = localityFallbackNote(q, pick)
      setMapError(note)
      setHints(found)
      goTo(pick.lat, pick.lon, pick.display, pick.kind === 'place' ? 17 : 19)
    } finally {
      setSearching(false)
    }
  }

  function patch(partial: Partial<LocationInput>) {
    onChange({ ...value, ...partial })
  }

  function removeZone(id: string) {
    const zones = valueRef.current.zones.filter((z) => z.id !== id)
    onChangeRef.current(applyZones(valueRef.current, zones))
    setSelectedId((cur) => (cur === id ? null : cur))
  }

  function chooseTool(next: Exclude<MapTool, 'none'>) {
    if (tool === next) {
      setTool('none')
      return
    }
    if (next === 'draw') setSelectedId(null)
    if (next === 'rotate' || next === 'resize') {
      setSelectedId((id) => id ?? value.zones.at(-1)?.id ?? null)
    }
    setTool(next)
  }

  function onAzimuth(next: number) {
    const selected = tool !== 'draw' ? value.zones.find((z) => z.id === selectedId) : undefined
    if (selected) {
      const zones = value.zones.map((z) =>
        z.id === selected.id
          ? { ...z, azimuthDeg: next, corners: rotateZone(z.corners, next) }
          : z,
      )
      onChange(applyZones({ ...value, roofAzimuthDeg: next }, zones))
      return
    }
    patch({ roofAzimuthDeg: next })
  }

  function geoMe() {
    navigator.geolocation.getCurrentPosition((pos) => {
      void reverse(pos.coords.latitude, pos.coords.longitude).then((address) =>
        goTo(pos.coords.latitude, pos.coords.longitude, address),
      )
    })
  }

  const selected = value.zones.find((z) => z.id === selectedId)
  const drawingAzimuth = tool === 'draw' || !selected
  const azimuthUi = drawingAzimuth ? value.roofAzimuthDeg : selected.azimuthDeg

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        <div className="search-box">
          <div className="search-row">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitSearch(e.currentTarget.value)
                }
                if (e.key === 'Escape') setHints([])
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  if (selectedId && document.activeElement !== searchRef.current) {
                    e.preventDefault()
                    removeZone(selectedId)
                  }
                }
              }}
              placeholder="Rua, n.º e localidade — ex.: Vila Franca do Rosário"
              className="field"
            />
            <button type="button" className="btn" disabled={searching} onClick={() => void commitSearch()}>
              Ir
            </button>
            <button type="button" className="btn-ghost shrink-0" onClick={geoMe}>
              GPS
            </button>
          </div>
          {hints.length > 0 && (
            <ul className="search-hints">
              {hints.map((h) => (
                <li key={`${h.lat},${h.lon},${h.display}`}>
                  <button
                    type="button"
                    className="hint-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(h.lat, h.lon, h.display, h.kind === 'place' ? 17 : 19)}
                  >
                    <strong>{h.display}</strong>
                    {h.detail ? <span className="hint-detail">{h.detail}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={`map-shell ${tool === 'draw' ? 'is-draw' : ''} ${tool === 'rotate' ? 'is-rotate' : ''} ${tool === 'resize' ? 'is-resize' : ''} ${tool === 'pan' ? 'is-pan' : ''} ${tool === 'none' ? 'is-browse' : ''}`}>
          <div ref={mapEl} className="h-full w-full" />
          <div className="map-tools">
            <button
              type="button"
              className={tool === 'pan' ? 'tool on' : 'tool'}
              onClick={() => chooseTool('pan')}
            >
              Mover
            </button>
            <button
              type="button"
              className={tool === 'draw' ? 'tool on' : 'tool'}
              onClick={() => chooseTool('draw')}
            >
              Desenhar
            </button>
            <button
              type="button"
              className={tool === 'resize' ? 'tool on' : 'tool'}
              onClick={() => chooseTool('resize')}
            >
              Tamanho
            </button>
            <button
              type="button"
              className={tool === 'rotate' ? 'tool on' : 'tool'}
              onClick={() => chooseTool('rotate')}
            >
              Rodar
            </button>
            <button
              type="button"
              className={tool === 'erase' ? 'tool on' : 'tool'}
              onClick={() => chooseTool('erase')}
            >
              Apagar
            </button>
          </div>
          <div className="map-hint">
            {tool === 'draw'
              ? 'Arraste o dedo ou o rato no telhado. Para reposicionar as zonas, toque em Mover.'
              : tool === 'resize'
                ? 'Arraste um canto para alongar ou encolher a zona. Arraste no meio para a aumentar ou diminuir por igual.'
                : tool === 'rotate'
                  ? 'Arraste a zona ou o ponto para a alinhar com o telhado.'
                  : tool === 'erase'
                    ? 'Toque numa zona para a remover.'
                    : tool === 'pan'
                      ? 'Arraste uma zona para a mover. Fora da zona, o mapa desloca-se.'
                      : 'Desloque o mapa. Toque em Desenhar para marcar uma água do telhado.'}
          </div>
        </div>
        {mapError && (
          <p className={mapError.includes('número de polícia') ? 'ok' : 'err'}>{mapError}</p>
        )}
      </div>

      <div className="card space-y-4">
        <h3 className="section-title">Telhado e módulos</h3>
        <label className="label">
          Azimute {drawingAzimuth ? 'para desenhar a próxima zona' : 'da zona selecionada'}
          <input
            type="range"
            min={0}
            max={359}
            value={azimuthUi}
            onChange={(e) => onAzimuth(Number(e.target.value))}
          />
          <span className="meta">
            {Math.round(azimuthUi)}° · {compassLabel(azimuthUi)}
            {azimuthUi > 135 && azimuthUi < 225 ? ' (ideal em Portugal)' : ''}
          </span>
        </label>
        <label className="label">
          Inclinação
          <span className="tilt-row">
            <input
              type="range"
              min={0}
              max={60}
              value={value.roofTiltDeg}
              onChange={(e) => patch({ roofTiltDeg: Number(e.target.value) })}
            />
            <TiltSketch deg={value.roofTiltDeg} />
          </span>
          <span className="meta">
            {value.roofTiltDeg}° relativamente à horizontal. No mapa, as riscas (filas de módulos) ficam mais juntas
            quanto maior for a inclinação.
          </span>
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="font-medium">Zonas no telhado</h4>
            <span className="meta">{value.availableAreaM2.toFixed(1)} m² no total</span>
          </div>
          {value.zones.length === 0 ? (
            <p className="hint">
              Ainda não há zonas. Toque em Desenhar, escolha o azimute da água e arraste sobre o telhado.
            </p>
          ) : (
            <ul className="zone-list">
              {value.zones.map((z, i) => (
                <li key={z.id}>
                  <button
                    type="button"
                    className={z.id === selectedId ? 'zone on' : 'zone'}
                    onClick={() => {
                      setSelectedId(z.id)
                      if (tool === 'draw') setTool('rotate')
                      focusZone(z)
                    }}
                  >
                    <strong>Zona {i + 1}</strong>
                    <span>
                      {polygonAreaM2(z.corners).toFixed(1)} m² · {Math.round(z.azimuthDeg)}°{' '}
                      {compassLabel(z.azimuthDeg)} · {Math.round(value.roofTiltDeg)}°
                    </span>
                  </button>
                  <button type="button" className="icon-btn" onClick={() => removeZone(z.id)} aria-label="Remover zona">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="hint">
          Cada retângulo é uma água do telhado. As riscas seguem o azimute e apertam com a inclinação (vista de cima).
          Desenhe, use Tamanho para a ajustar e Rodar para alinhar os módulos à cobertura.
        </p>
      </div>
    </div>
  )
}
