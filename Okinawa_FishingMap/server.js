import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleJmaTideRequest } from './server/jma-tide.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const staticDirectory = path.join(root, 'dist')
const port = Number(process.env.PORT ?? 8080)
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

createServer(async (request, response) => {
  try {
    if (await handleJmaTideRequest(request, response)) return
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const filePath = path.resolve(staticDirectory, `.${pathname}`)
    if (filePath !== staticDirectory && !filePath.startsWith(`${staticDirectory}${path.sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    let target = filePath
    try {
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      target = path.join(staticDirectory, 'index.html')
    }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(target)] ?? 'application/octet-stream' })
    response.end(await readFile(target))
  } catch (error) {
    console.error('HTTP request failed:', error)
    response.writeHead(500).end('Internal server error')
  }
}).listen(port, '0.0.0.0', () => console.log(`Okinawa Fishing Map listening on ${port}`))
