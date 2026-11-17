import { tideStations } from '../src/tideStations.js'

const stationCodes = new Set(tideStations.map(station => station.code))
const annualDataCache = new Map()
const jmaDataUrl = 'https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt'
const jmaTideTableUrl = 'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/suisan.php'
const cacheTtlMs = 15 * 60 * 1000

function getAnnualData(year, stationCode) {
  const key = `${year}:${stationCode}`
  const cached = annualDataCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.promise

  const entry = { expiresAt: Date.now() + cacheTtlMs, promise: null }
  entry.promise = fetch(`${jmaDataUrl}/${year}/${stationCode}.txt`, { signal: AbortSignal.timeout(15000) })
    .then(async response => {
      if (!response.ok) throw new Error(`JMA returned ${response.status} for ${stationCode}/${year}`)
      return response.text()
    })
    .catch(error => {
      if (annualDataCache.get(key) === entry) annualDataCache.delete(key)
      throw error
    })
  annualDataCache.set(key, entry)
  return entry.promise
}

function parseTideLine(line, year, stationCode) {
  if (line.length < 80 || line.slice(78, 80).trim() !== stationCode) return null
  const lineYear = 2000 + Number(line.slice(72, 74))
  const month = Number(line.slice(74, 76))
  const day = Number(line.slice(76, 78))
  if (lineYear !== year || !month || !day) return null

  const hourlyHeights = Array.from({ length: 24 }, (_, hour) => {
    const heightCm = Number(line.slice(hour * 3, hour * 3 + 3).trim())
    return Number.isFinite(heightCm) ? { hour, heightCm } : null
  })
  if (hourlyHeights.some(point => point === null)) return null

  const readEvents = offset => Array.from({ length: 4 }, (_, index) => {
    const event = line.slice(offset + index * 7, offset + (index + 1) * 7)
    if (event.length < 7 || event.slice(0, 4) === '9999') return null
    const minutes = Number(event.slice(0, 2)) * 60 + Number(event.slice(2, 4))
    const heightCm = Number(event.slice(4, 7).trim())
    if (!Number.isFinite(minutes) || minutes >= 1440 || !Number.isFinite(heightCm)) return null
    return { time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, heightCm }
  }).filter(Boolean)

  return {
    date: `${lineYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hourlyHeights,
    highTides: readEvents(80),
    lowTides: readEvents(108),
  }
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year < 2000 || year > 2099 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day }
}

function sourceUrl(stationCode, { year, month, day }) {
  const query = new URLSearchParams({ stn: stationCode, ys: String(year), ms: String(month), ds: String(day), ye: String(year), me: String(month), de: String(day) })
  return `${jmaTideTableUrl}?${query}`
}

export async function getJmaTide(stationCode, dateString) {
  if (!stationCodes.has(stationCode)) {
    const error = new Error('気象庁の潮位表に掲載されていない地点です。')
    error.statusCode = 400
    throw error
  }
  const date = parseDate(dateString)
  if (!date) {
    const error = new Error('日付の形式が正しくありません。')
    error.statusCode = 400
    throw error
  }

  const text = await getAnnualData(date.year, stationCode)
  const targetDate = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
  const tide = text.split(/\r?\n/).map(line => parseTideLine(line, date.year, stationCode)).find(item => item?.date === targetDate)
  if (!tide) {
    const error = new Error('選択日の気象庁潮位データが見つかりません。')
    error.statusCode = 404
    throw error
  }
  return { ...tide, station: tideStations.find(item => item.code === stationCode), sourceUrl: sourceUrl(stationCode, date) }
}

export async function handleJmaTideRequest(request, response) {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname !== '/api/tides') return false
  try {
    const tide = await getJmaTide(url.searchParams.get('station'), url.searchParams.get('date'))
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900' })
    response.end(JSON.stringify(tide))
  } catch (error) {
    const statusCode = error.statusCode ?? 502
    if (statusCode === 502) console.error('JMA tide request failed:', error)
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ error: statusCode === 502 ? '気象庁の潮位データを取得できませんでした。時間をおいて再度お試しください。' : error.message }))
  }
  return true
}
