import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveStore, HISTORICAL_SEED } from './lib/store.js'
import { RailSimulator } from './lib/telemetry.js'
import { computePrediction } from './lib/prediction.js'
import { positionAt, routeGeometry, routeProfileFor, TRAIN_PROFILES } from './lib/routes.js'
import { contextForStatus } from './lib/routeContext.js'
import { fetchRealTrainStatus } from './lib/realapi.mjs'
import { demoStatusFor } from './lib/demo.js'

// Loads optional `.env` with IRCTC_API_KEY / IRCTC_API_BASE_URL.
// See `.env.example` — paste your provider key there to switch ON live data.
function loadEnvFile() {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {}
}

loadEnvFile()
const port = Number(process.env.API_PORT || 8787)
const providerKey = process.env.IRCTC_API_KEY
const root = fileURLToPath(new URL('.', import.meta.url))
const dist = join(root, 'dist')

const store = new LiveStore()
store.seedHistory(HISTORICAL_SEED)
const sim = new RailSimulator(store)
sim.start()

const demoTrains = [{ number: '12345', name: 'New Delhi to Howrah Rajdhani Express', departure: '16:00', arrival: '20:27', fare: 1540, availability: 'AVAILABLE 12' }, { number: '12951', name: 'Mumbai Rajdhani Express', departure: '17:00', arrival: '06:13', fare: 1825, availability: 'RAC 4' }, { number: '12002', name: 'Bhopal Shatabdi Express', departure: '06:00', arrival: '14:25', fare: 850, availability: 'AVAILABLE 28' }]

function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); response.end(JSON.stringify(body)) }
function staticFile(response, requestUrl) { const requested = requestUrl === '/' ? '/index.html' : requestUrl.split('?')[0]; const file = join(dist, requested); const fallback = join(dist, 'index.html'); const target = existsSync(file) && !requested.endsWith('/') ? file : fallback; const types = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' }; response.writeHead(200, { 'Content-Type': types[extname(target)] || 'text/html' }); response.end(readFileSync(target)) }
function readBody(request) { return new Promise(resolve => { let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } }) }) }

// Joint simulator telemetry + prediction engine into the standard status shape.
// Used for the 4 seeded rail profiles (12345, 12951, 12002, 12295).
function simulatorStatus(number) {
  const telemetry = liveTelemetry(number)
  const pred = computePrediction({ train: { number }, telemetry, historical: store.historyFor(number), weather: sim.currentWeather(number), conditions: sim.currentConditions(number) })
  const profile = routeProfileFor(number)
  const geometry = routeGeometry(number)
  const [currentStation = 'Loading', nextStation = 'Next station'] = String(telemetry.leg || '').split(' - ')
  let seen = false
  const stops = geometry.waypoints.map(wp => {
    if (wp.name === currentStation) seen = true
    return { name: wp.name, scheduled: '--', expected: '--', status: wp.name === currentStation ? 'current' : seen ? 'upcoming' : 'completed', platform: wp.name === currentStation ? String(1 + (Number(number) % 8)) : undefined }
  })
  return {
    provider: pred.provider,
    mode: 'simulated',
    number,
    name: profile.name,
    route: `${profile.origin} - ${profile.destination}`,
    origin: profile.origin,
    destination: profile.destination,
    currentStation,
    nextStation,
    lastLocation: `between ${currentStation} and ${nextStation}`,
    platform: String(1 + (Number(number) % 8)),
    speedKmh: pred.speedKmh,
    coveredKm: pred.coveredKm,
    remainingKm: pred.remainingKm,
    progress: pred.progress,
    distance: pred.remainingKm ? `${pred.remainingKm} km to go` : `${pred.coveredKm} km covered`,
    eta: pred.eta,
    scheduledEta: pred.scheduledEta,
    delay: pred.predictedDelayMin,
    status: pred.status,
    confidence: pred.confidence,
    accuracy: `${pred.confidence}%`,
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    stops,
    weather: pred.weather,
    delayReason: pred.delayReason,
    delayDetail: pred.delayDetail,
    at: new Date().toISOString(),
  }
}

// Demo/fallback status for ANY train number (works even without an API key).
// Seeded rail profiles use the simulator + store context; any other number gets
// synchronized station/journey context computed from the live status response.
function knownStatusFor(number) {
  const key = String(number)
  if (TRAIN_PROFILES[key]) {
    const status = simulatorStatus(key)
    const ctx = store.contextFor(key) || contextForStatus(status)
    return { ...status, routeContext: ctx }
  }
  const status = demoStatusFor(key)
  return { ...status, routeContext: contextForStatus(status) }
}

function liveTelemetry(number) {
  const latest = store.latestSnapshot(number)
  if (latest) return latest
  const geometry = routeGeometry(number)
  return { number, at: new Date().toISOString(), timestamp: Date.now(), lat: geometry.waypoints[0].lat, lng: geometry.waypoints[0].lng, leg: 'Origin', speedKmh: 0, coveredKm: 0, remainingKm: geometry.totalKm, progress: 0, source: 'default' }
}

function handlePredict(body) {
  const number = String(body.number || '12345')
  const telemetry = body.lat != null || body.speedKmh != null || body.distanceCoveredKm != null
    ? { number, timestamp: Date.now(), at: new Date().toISOString(), lat: Number(body.lat) || 0, lng: Number(body.lng) || 0, leg: body.leg || 'Live feed', speedKmh: Number(body.speedKmh) || 0, coveredKm: body.distanceCoveredKm != null ? Number(body.distanceCoveredKm) : 0, remainingKm: Number(body.remainingKm) || 0, progress: Number(body.progress) || 0, source: 'client-telemetry' }
    : liveTelemetry(number)
  const weather = body.weather || sim.currentWeather(number)
  const conditions = body.conditions || sim.currentConditions(number)
  return computePrediction({ train: { number }, telemetry, historical: store.historyFor(number), weather, conditions })
}

const sseClients = new Set()
function broadcastSample(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of sseClients) { try { res.write(payload) } catch {} }
}
sim.subscribe(broadcastSample)

const server = createServer(async (request, response) => {
  const url = request.url || '/'
  if (request.method === 'OPTIONS') return json(response, 204, {})

  if (request.method === 'GET' && url === '/api/health') return json(response, 200, { ok: true, provider: providerKey ? 'indianrailapi (live)' : 'demo (no IRCTC_API_KEY)', sim: sim.summary(), store: store.summary() })

  if (request.method === 'GET' && url === '/api/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    response.write(': connected\n\n')
    const number = '12345'
    const latest = store.latestSnapshot(number)
    const pred = store.predictions.find(p => String(p.number) === number) || null
    const ctx = store.contextFor(number)
    if (latest) response.write(`data: ${JSON.stringify({ type: 'snapshot', number, telemetry: latest, prediction: pred })}\n\n`)
    if (ctx) response.write(`data: ${JSON.stringify({ type: 'route-context', number, context: ctx })}\n\n`)
    sseClients.add(response)
    request.on('close', () => sseClients.delete(response))
    return
  }

  if (request.method === 'GET' && url.startsWith('/api/history')) {
    const params = new URL(url, 'http://x').searchParams
    return json(response, 200, store.historyFor(params.get('number') || '12345'))
  }

  if (request.method === 'GET' && url.startsWith('/api/weather')) {
    const params = new URL(url, 'http://x').searchParams
    return json(response, 200, { trainNumber: params.get('number') || '12345', ...sim.currentWeather(params.get('number') || '12345'), forecast: 'Route weather is streamed live with the prediction engine' })
  }

  if (request.method === 'GET' && url.startsWith('/api/conditions')) {
    const params = new URL(url, 'http://x').searchParams
    return json(response, 200, { trainNumber: params.get('number') || '12345', ...sim.currentConditions(params.get('number') || '12345') })
  }

  if (request.method === 'GET' && url.startsWith('/api/route-context')) {
    const params = new URL(url, 'http://x').searchParams
    return json(response, 200, { number: params.get('number') || '', message: 'API working' })
  }

  if (request.method === 'GET' && url.startsWith('/api/snapshots')) {
    const params = new URL(url, 'http://x').searchParams
    const limit = Number(params.get('limit')) || 12
    const number = params.get('number')
    return json(response, 200, { count: store.snapshotsFor(number, 500).length, snapshots: store.snapshotsFor(number, limit) })
  }

  if (request.method === 'GET' && url.startsWith('/api/notifications')) {
    const params = new URL(url, 'http://x').searchParams
    const limit = Number(params.get('limit')) || 12
    const number = params.get('number')
    const list = number ? store.notifications.filter(n => String(n.number) === number) : store.notifications
    return json(response, 200, { notifications: list.slice(0, limit) })
  }

  if (request.method === 'GET' && url.startsWith('/api/staff')) {
    const params = new URL(url, 'http://x').searchParams
    const limit = Number(params.get('limit')) || 20
    return json(response, 200, { count: store.staff.length, entries: store.staff.slice(-limit).reverse() })
  }

  if (request.method === 'GET' && !url.startsWith('/api/')) return existsSync(dist) ? staticFile(response, request.url) : json(response, 503, { error: 'Frontend build not found. Run npm run build.' })

  if (request.method !== 'POST') return json(response, 404, { error: 'Not found' })
  const body = await readBody(request)

  if (url === '/api/predict') return json(response, 200, handlePredict(body))

  if (url === '/api/snapshot' && body.type === 'staff-view') {
    store.recordStaff({ viewer: body.viewer || 'staff', trainNumber: String(body.number || '12345'), action: body.action || 'monitor' })
    return json(response, 200, { ok: true, snapshots: store.snapshotsFor(String(body.number || '12345'), 8) })
  }

  // --------------------------------------------------------------------------
  // LUXURY LIVE STATUS endpoint — works for ANY train number.
  //   * With IRCTC_API_KEY set  -> real data from the provider (lib/realapi.js)
  //   * Without it              -> simulated demo data (lib/demo.js), clearly
  //                                labelled so the UI still works end-to-end.
  // --------------------------------------------------------------------------
  if (url === '/api/status') {
    const number = String(body.number || '').trim()
    if (!number) return json(response, 400, { error: 'Train number required' })
    const date = String(body.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''))
    if (providerKey) {
      try {
        return json(response, 200, await fetchRealTrainStatus(number, date))
      } catch (error) {
        const fallback = knownStatusFor(number)
        return json(response, 200, { ...fallback, provider: `${fallback.provider} · live provider unreachable`, mode: 'simulated-fallback' })
      }
    }
    return json(response, 200, knownStatusFor(number))
  }

  if (url === '/api/availability') return json(response, 200, { provider: 'Smart Coach Guardian demo', trains: demoTrains })

  return json(response, 404, { error: 'Not found' })
})

server.listen(port, '0.0.0.0', () => console.log(`Smart Coach Guardian API listening on http://localhost:${port} (provider: ${providerKey ? 'LIVE indianrailapi' : 'DEMO - add IRCTC_API_KEY to .env for live data'})`))

function shutdown() { sim.stop(); store.persist(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)