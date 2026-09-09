/** Dev uses the Vite proxy; GitHub Pages calls public APIs directly. */

const DEV = import.meta.env.DEV

export function publicUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
}

export function photonSearchUrl(query: string): string {
  return DEV ? `/api/geo/api/?${query}` : `https://photon.komoot.io/api/?${query}`
}

export function photonReverseUrl(lat: number, lon: number): string {
  const q = `lat=${lat}&lon=${lon}`
  return DEV ? `/api/geo/reverse?${q}` : `https://photon.komoot.io/reverse?${q}`
}

export function nominatimSearchUrl(query: string): string {
  return DEV
    ? `/api/nominatim/search?${query}`
    : `https://nominatim.openstreetmap.org/search?${query}`
}

export const esriImageryTiles = DEV
  ? '/tiles/world-imagery/{z}/{y}/{x}'
  : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export const esriPlacesTiles = DEV
  ? '/tiles/world-places/{z}/{y}/{x}'
  : 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'

export function esriImageryTileUrl(z: number, y: number, x: number): string {
  return DEV
    ? `/tiles/world-imagery/${z}/${y}/${x}`
    : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
}

export function esriExportUrl(bbox: string, size: number): string {
  const q = `bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${size},${size}&format=png&f=image`
  return DEV
    ? `/api/imagery/export?${q}`
    : `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?${q}`
}

export const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive'
