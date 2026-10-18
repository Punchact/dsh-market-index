#!/usr/bin/env node
/**
 * 本地静态索引服务：把同目录的 index.json 以 http 暴露给 DSH 插件市场。
 *
 *   node serve.mjs                 # 默认 http://127.0.0.1:8787/index.json
 *   node serve.mjs --port 8788     # 换端口
 *   node serve.mjs --host 127.0.0.1
 *
 * 只读：只发 serve.mjs 同目录下的文件，不写任何东西。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const host = option('host', '127.0.0.1')
const port = Number(option('port', '8787'))

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const target = normalize(join(HERE, relative || 'index.json'))
  if (!target.startsWith(HERE + sep) || relative.includes('..')) {
    response.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(target)
    const type = TYPES[target.slice(target.lastIndexOf('.'))] ?? 'application/octet-stream'
    response.writeHead(200, {
      'content-type': type,
      'content-length': String(body.byteLength),
      'cache-control': 'no-cache',
      // 索引由 Host 进程抓取，浏览器端只用于同源图标；放开 CORS 便于手工调试。
      'access-control-allow-origin': '*',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
})

server.listen(port, host, () => {
  console.log(`index source: http://${host}:${String(port)}/index.json`)
})
