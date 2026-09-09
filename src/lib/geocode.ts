import { nominatimSearchUrl, photonSearchUrl } from './endpoints'

export interface GeoHit {
  display: string
  detail?: string
  lat: number
  lon: number
  kind: 'house' | 'street' | 'place'
}

const STOP = new Set([
  'de',
  'do',
  'da',
  'dos',
  'das',
  'e',
  'o',
  'a',
  'os',
  'as',
  'em',
  'no',
  'na',
  'rua',
  'av',
  'avenida',
  'tv',
  'travessa',
  'pt',
  'portugal',
])

const STREET_PREFIX =
  /^(r\.|rua|avenida|av\.?|travessa|tv\.?|estrada|en\b|n\d+|largo|pra[cç]a|praceta|beco|alameda|caminho|cal[cç]ada|urbaniza[cç][aã]o|s[ií]tio)\b/i

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function tokens(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

export function parsePtAddress(text: string): { street: string; housenumber: string; locality: string } {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const parts = cleaned
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (parts.length >= 2) {
    const street = parts[0]
    const rest = parts.slice(1).join(' ')
    const numbered = rest.match(/^(\d+\w*)\s+(.*)$/)
    if (numbered?.[2]) return { street, housenumber: numbered[1], locality: numbered[2].trim() }
    const onlyNum = rest.match(/^(\d+\w*)$/)
    if (onlyNum) return { street, housenumber: onlyNum[1], locality: parts[2] ?? '' }
    return { street, housenumber: '', locality: rest }
  }

  if (STREET_PREFIX.test(cleaned)) {
    const numbered = cleaned.match(/^(.*)\s+(\d+\w*)\s+(.+)$/)
    if (numbered) {
      return { street: numbered[1].trim(), housenumber: numbered[2], locality: numbered[3].trim() }
    }
    return { street: cleaned, housenumber: '', locality: '' }
  }

  return { street: '', housenumber: '', locality: cleaned }
}

function distinctTokens(list: string[]): string[] {
  return list.filter((t) => t.length >= 5 && !['vila', 'nova', 'santo', 'santa', 'uniao', 'freguesia'].includes(t))
}

export function scoreHit(hit: GeoHit, query: string, locality: string): number {
  const hay = new Set(tokens(`${hit.display} ${hit.detail ?? ''}`))
  const qt = tokens(query)
  let score = 0
  for (const t of qt) {
    if ([...hay].some((h) => h === t || h.startsWith(t) || t.startsWith(h))) {
      score += t.length >= 4 ? 4 : 2
    }
  }
  const loc = distinctTokens(tokens(locality))
  if (loc.length) {
    const hits = loc.filter((t) => [...hay].some((h) => h === t || h.includes(t) || t.includes(h)))
    score += (hits.length / loc.length) * 40
    if (hits.length === 0) score -= 30
  }
  if (hit.kind === 'house') score += 6
  if (hit.kind === 'place' && loc.length && score > 0) score += 8
  if (locality && fold(hit.display).startsWith(fold(locality))) score += 12
  return score
}

function photonKind(osmValue?: string, type?: string): GeoHit['kind'] {
  if (type === 'house' || osmValue === 'house' || osmValue === 'yes') return 'house'
  if (type === 'street' || osmValue === 'residential' || osmValue === 'unclassified') return 'street'
  return 'place'
}

function formatPhoton(p: {
  name?: string
  street?: string
  housenumber?: string
  city?: string
  locality?: string
  district?: string
  county?: string
  country?: string
}): { display: string; detail?: string } {
  const street = [p.street || p.name, p.housenumber].filter(Boolean).join(' ')
  const place = p.city || p.locality || p.district || p.county
  const display = [street, place].filter(Boolean).join(', ')
  const detail = [p.district && p.district !== place ? p.district : '', p.county, p.country]
    .filter(Boolean)
    .join(' · ')
  return { display, detail: detail || undefined }
}

async function photonSearch(q: string, bias?: { lat: number; lon: number }): Promise<GeoHit[]> {
  const params = new URLSearchParams({
    q,
    limit: '10',
    bbox: '-9.7,36.9,-6.1,42.2',
  })
  if (bias) {
    params.set('lat', String(bias.lat))
    params.set('lon', String(bias.lon))
  }
  const res = await fetch(photonSearchUrl(params.toString()))
  if (!res.ok) return []
  const json = (await res.json()) as {
    features?: {
      geometry: { coordinates: [number, number] }
      properties: {
        name?: string
        street?: string
        housenumber?: string
        city?: string
        locality?: string
        district?: string
        county?: string
        country?: string
        osm_value?: string
        type?: string
      }
    }[]
  }
  return (json.features ?? [])
    .map((f) => {
      const { display, detail } = formatPhoton(f.properties)
      return {
        display,
        detail,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        kind: photonKind(f.properties.osm_value, f.properties.type),
      }
    })
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon) && h.display)
}

function formatNominatim(item: {
  display_name?: string
  lat: string
  lon: string
  addresstype?: string
  type?: string
  class?: string
  address?: Record<string, string>
}): GeoHit | null {
  const a = item.address ?? {}
  const street = [a.road || a.pedestrian || a.street, a.house_number].filter(Boolean).join(' ')
  const place =
    a.village || a.hamlet || a.town || a.city || a.municipality || a.suburb || a.neighbourhood
  const display = street && place ? `${street}, ${place}` : street || place || item.display_name || ''
  const detail = [a.municipality && a.municipality !== place ? a.municipality : '', a.county, a.state]
    .filter(Boolean)
    .join(' · ')
  const kind: GeoHit['kind'] =
    a.house_number || item.addresstype === 'building' || item.type === 'house'
      ? 'house'
      : item.addresstype === 'road' || item.class === 'highway'
        ? 'street'
        : 'place'
  const lat = Number(item.lat)
  const lon = Number(item.lon)
  if (!display || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { display, detail: detail || undefined, lat, lon, kind }
}

async function nominatimSearch(q: string, extra?: Record<string, string>): Promise<GeoHit[]> {
  const params = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    limit: '8',
    countrycodes: 'pt',
    'accept-language': 'pt',
    q,
    ...extra,
  })
  const res = await fetch(nominatimSearchUrl(params.toString()))
  if (!res.ok) return []
  const json = (await res.json()) as Parameters<typeof formatNominatim>[0][]
  if (!Array.isArray(json)) return []
  return json.map(formatNominatim).filter((h): h is GeoHit => !!h)
}

function dedupe(hits: GeoHit[]): GeoHit[] {
  const seen = new Set<string>()
  const out: GeoHit[] = []
  for (const h of hits) {
    const key = `${h.display.toLowerCase()}|${h.lat.toFixed(4)}|${h.lon.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
  }
  return out
}

function near(a: { lat: number; lon: number }, b: { lat: number; lon: number }, km: number): boolean {
  const dy = (a.lat - b.lat) * 111
  const dx = (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dx, dy) <= km
}

export async function geocodeAddress(
  text: string,
  bias?: { lat: number; lon: number },
  extraHits: GeoHit[] = [],
): Promise<GeoHit[]> {
  const q = text.trim()
  if (q.length < 3) return []
  const { street, housenumber, locality } = parsePtAddress(q)
  const streetQ = [street, housenumber].filter(Boolean).join(' ')

  const jobs: Promise<GeoHit[]>[] = [photonSearch(q, bias), nominatimSearch(q)]
  if (locality && fold(locality) !== fold(q)) {
    jobs.push(photonSearch(locality, bias), nominatimSearch(locality))
  }
  if (streetQ && locality) {
    jobs.push(nominatimSearch(`${streetQ}, ${locality}, Portugal`))
  }

  const batches = await Promise.all(jobs.map((p) => p.catch(() => [] as GeoHit[])))
  let hits = dedupe([...extraHits, ...batches.flat()])

  const place = hits
    .filter((h) => h.kind === 'place')
    .sort((a, b) => scoreHit(b, locality || q, locality) - scoreHit(a, locality || q, locality))[0]

  if (streetQ && place) {
    const nearby = (await photonSearch(streetQ, { lat: place.lat, lon: place.lon }).catch(() => [])).filter(
      (h) => near(h, place, 6),
    )
    hits = dedupe([...hits, ...nearby])
  }

  return dedupe(hits)
    .map((h) => ({ hit: h, score: scoreHit(h, q, locality) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.hit)
}

export function localityFallbackNote(query: string, pick: GeoHit | undefined): string {
  if (!pick) return ''
  const { street, locality } = parsePtAddress(query)
  if (!street || pick.kind === 'house') return ''
  const loc = distinctTokens(tokens(locality || query))
  const hay = tokens(pick.display)
  const matched = loc.filter((t) => hay.some((h) => h === t || h.includes(t)))
  if (pick.kind === 'place' && (matched.length > 0 || !locality)) {
    return 'Não encontrei o número de polícia neste mapa. Ajustei a vista à localidade — aproxime a casa na imagem aérea e desenhe o telhado.'
  }
  return ''
}
