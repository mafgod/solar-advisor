import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import { gmapsPlugin, googleMapsKey } from './vite.gmaps.ts'

const proxy: Record<string, ProxyOptions> = {
  '/api/pvgis': {
    target: 'https://re.jrc.ec.europa.eu',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/pvgis/, '/api/v5_3'),
  },
  '/api/imagery': {
    target: 'https://services.arcgisonline.com',
    changeOrigin: true,
    rewrite: (path) =>
      path.replace(
        /^\/api\/imagery/,
        '/arcgis/rest/services/World_Imagery/MapServer',
      ),
  },
  '/api/geo': {
    target: 'https://photon.komoot.io',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/geo/, ''),
  },
  '/api/nominatim': {
    target: 'https://nominatim.openstreetmap.org',
    changeOrigin: true,
    secure: false,
    rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
    headers: {
      'User-Agent': 'CasaSolar/1.0 (estudo de autoconsumo residencial)',
      'Accept-Language': 'pt',
    },
  },
  '/tiles/world-imagery': {
    target: 'https://server.arcgisonline.com',
    changeOrigin: true,
    rewrite: (path) =>
      path.replace(
        /^\/tiles\/world-imagery/,
        '/ArcGIS/rest/services/World_Imagery/MapServer/tile',
      ),
  },
  '/tiles/world-places': {
    target: 'https://server.arcgisonline.com',
    changeOrigin: true,
    rewrite: (path) =>
      path.replace(
        /^\/tiles\/world-places/,
        '/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile',
      ),
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: process.env.BASE_PATH || '/',
    plugins: [react(), tailwindcss(), gmapsPlugin(googleMapsKey(env))],
    server: { port: 5173, host: true, proxy },
    preview: { port: 4173, host: true, proxy },
  }
})
