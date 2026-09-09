import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export function googleMapsKey(env: Record<string, string>): string {
  return (env.GOOGLE_MAPS_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function handleGmaps(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<boolean> {
  const raw = req.url ?? ''
  const path = raw.split('?')[0]
  if (!path.startsWith('/api/gmaps/')) return false

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method' })
    return true
  }

  if (path === '/api/gmaps/status') {
    sendJson(res, 200, { enabled: Boolean(key) })
    return true
  }

  if (path === '/api/gmaps/geocode') {
    if (!key) {
      sendJson(res, 200, { results: [] })
      return true
    }
    const q = new URL(raw, 'http://localhost').searchParams.get('q')?.trim() ?? ''
    if (q.length < 3 || q.length > 200) {
      sendJson(res, 200, { results: [] })
      return true
    }
    try {
      const gUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json')
      gUrl.searchParams.set('address', q)
      gUrl.searchParams.set('region', 'pt')
      gUrl.searchParams.set('language', 'pt-PT')
      gUrl.searchParams.set('components', 'country:PT')
      gUrl.searchParams.set('key', key)
      const upstream = await fetch(gUrl)
      const json = (await upstream.json()) as { results?: unknown[]; status?: string }
      if (!upstream.ok || json.status === 'REQUEST_DENIED') {
        sendJson(res, 200, { results: [] })
        return true
      }
      sendJson(res, 200, { results: Array.isArray(json.results) ? json.results : [] })
    } catch {
      sendJson(res, 200, { results: [] })
    }
    return true
  }

  sendJson(res, 404, { error: 'not_found' })
  return true
}

export function gmapsPlugin(key: string): Plugin {
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    void handleGmaps(req, res, key).then((handled) => {
      if (!handled) next()
    })
  }
  return {
    name: 'casasolar-gmaps',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
