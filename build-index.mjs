#!/usr/bin/env node
/**
 * 把 1024 Store（deepseek1024.com）的完整公开目录转成 DSH 插件市场索引格式 1。
 *
 * 数据来源：https://deepseek1024.com/api/v2/plugins（分页，limit 上限 200，全目录约 13800 条）。
 * 其中带 npm 安装法的进入索引；纯 GitHub 源的条目不进——索引格式 1 的 git source 要求固定
 * 40 位 commit，v2 只给分支形式的 spec，补全需要几千次 GitHub API 调用。
 *
 * 可选：--mark-installed 读本机 DSH profile 的依赖，给匹配上的插件打 `installed` 标签，
 * 发现页的「标签」菜单因此能筛出已安装项（格式 1 没有专门的 installed 过滤器）。
 *
 * 用法：
 *   node build-index.mjs                     # 抓目录 + npm 元数据，写 index.json
 *   node build-index.mjs --mark-installed    # 同时读本机 profile 打 installed 标签
 *   node build-index.mjs --offline           # 复用 npm-cache.json，不访问 npm registry
 *   node build-index.mjs --profile desktop   # 指定要读的 profile（默认 desktop）
 */

import { writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_BASE = 'https://deepseek1024.com/api/v2/plugins'
const PAGE_LIMIT = 200
const CACHE_PATH = join(HERE, 'npm-cache.json')
const OUTPUT_PATH = join(HERE, 'index.json')

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

const CONCURRENCY = 12
const LABEL_INSTALLED = { title: { en: 'Installed', zh: '已安装' } }

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

async function fetchJson(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
  throw lastError
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await mapper(items[index], index)
      done += 1
      if (done % 250 === 0) log(`  npm 元数据 ${done}/${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 目录条目的 install 命令形如 `dsh plugin --profile web add <spec>`；取回 spec。 */
function installSpec(command) {
  if (typeof command !== 'string') return undefined
  const at = command.lastIndexOf(' add ')
  return at === -1 ? undefined : command.slice(at + 5).trim()
}

/** 从 spec 里剥出版本/标签后缀，返回包名（scoped 包名本身以 @ 开头）。 */
function packageNameOf(spec) {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at === -1 ? spec : spec.slice(0, at)
}

function localized(text, fallback) {
  if (typeof text === 'string' && text.trim() !== '') return text
  if (text === null || typeof text !== 'object') return fallback
  const out = {}
  if (typeof text.en === 'string' && text.en.trim() !== '') out.en = text.en
  if (typeof text.zh === 'string' && text.zh.trim() !== '') out.zh = text.zh
  return out.en === undefined ? fallback : out
}

/** 整份目录：v2 分页拉完，按包名归并 npm 可安装的条目。 */
async function readCatalog() {
  const byName = new Map()
  let page = 1
  let totalPages = 1
  let rows = 0
  let gitOnly = 0
  let skipped = 0
  let categories = []
  for (;;) {
    const document = await fetchJson(`${CATALOG_BASE}?page=${String(page)}&limit=${String(PAGE_LIMIT)}`)
    totalPages = Number(document.totalPages ?? 1)
    if (page === 1 && Array.isArray(document.categories)) categories = document.categories
    for (const entry of document.plugins ?? []) {
      rows += 1
      const spec = installSpec(entry.install)
      if (spec === undefined || spec.includes('github:')) {
        gitOnly += 1
        continue
      }
      const name = packageNameOf(spec)
      if (!PACKAGE_NAME.test(name)) {
        skipped += 1
        continue
      }
      const suffix = spec.slice(name.length)
      const tag = suffix.startsWith('@') ? suffix.slice(1) : undefined
      const version = tag !== undefined && SEMVER.test(tag) ? tag : undefined
      const previous = byName.get(name)
      if (previous !== undefined) {
        previous.installs = Math.max(previous.installs, entry.installCount ?? 0)
        continue
      }
      byName.set(name, {
        name,
        version,
        category: entry.category,
        description: entry.description,
        title: entry.name,
        owner: entry.owner,
        url: entry.url,
        installs: entry.installCount ?? 0,
        stars: entry.stars ?? 0,
        added: entry.added,
      })
    }
    if (page >= totalPages) break
    page += 1
    if (page % 10 === 0) log(`  目录 ${page}/${totalPages} 页，累计 ${rows} 条`)
  }
  return { byName, rows, gitOnly, skipped, categories }
}

/** npm 元数据：目标版本、发布时间、engines.dsh，带 ETag 以便增量重建。 */
async function npmFacts(name, wantedVersion, cached, offline) {
  const stale =
    cached?.etag === undefined ||
    (wantedVersion !== undefined && cached.version !== wantedVersion)
  if (offline || !stale) return cached

  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name
  const headers = { accept: 'application/json' }
  if (cached?.etag !== undefined) headers['if-none-match'] = cached.etag
  try {
    const response = await fetch(`https://registry.npmjs.org/${encoded}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 304) return cached
    if (!response.ok) return cached
    const etag = response.headers.get('etag') ?? undefined
    const document = await response.json()
    const version = wantedVersion ?? document['dist-tags']?.latest
    if (typeof version !== 'string' || !SEMVER.test(version)) return cached
    const published = document.time?.[version]
    const engines = document.versions?.[version]?.engines ?? {}
    return {
      version,
      etag,
      publishTimestamp:
        typeof published === 'string' && Number.isFinite(Date.parse(published))
          ? Math.floor(Date.parse(published) / 1000)
          : undefined,
      dsh: typeof engines.dsh === 'string' ? engines.dsh : undefined,
    }
  } catch {
    return cached
  }
}

async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 本机 profile 里已安装的包名：dependencies 与 dsh.profile.bundles 的并集。 */
async function readInstalled(profileName) {
  const profilePath = join(homedir(), '.dsh', 'profiles', profileName, 'package.json')
  try {
    const document = JSON.parse(await readFile(profilePath, 'utf8'))
    const names = new Set()
    // 只认 dependencies：bundles 里的官方组合包由 DSH 自己标「随 DSH 提供」，不算用户装的。
    for (const [name, spec] of Object.entries(document.dependencies ?? {})) {
      if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) continue
      if (!name.includes(':')) names.add(name)
    }
    return names
  } catch {
    return new Set()
  }
}

async function main() {
  const offline = flag('offline')
  const markInstalled = flag('mark-installed')
  const profileName = option('profile', 'desktop')

  log(`抓取目录 ${CATALOG_BASE} …`)
  const catalog = await readCatalog()
  log(
    `目录 ${catalog.rows} 条：npm 可安装 ${catalog.byName.size} 个唯一包名，纯 Git 源 ${catalog.gitOnly} 条，非法 ${catalog.skipped} 条`,
  )

  const categories = {}
  for (const category of catalog.categories) {
    if (typeof category.id !== 'string' || category.id === '') continue
    categories[category.id] = {
      title: localized({ en: category.en, zh: category.zh }, { en: category.id }),
    }
  }

  const installed = markInstalled ? await readInstalled(profileName) : new Set()
  if (markInstalled) log(`本机 profile "${profileName}" 已安装 ${installed.size} 个包`)

  const cache = await readCache()
  const queue = [...catalog.byName.values()]
  const facts = await mapLimit(queue, CONCURRENCY, async (item) => {
    const value = await npmFacts(item.name, item.version, cache[item.name], offline)
    if (value !== undefined && value.version !== undefined) cache[item.name] = value
    return value
  })

  const plugins = []
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index]
    const fact = facts[index]
    const version = item.version ?? fact?.version
    if (typeof version !== 'string' || !SEMVER.test(version)) continue

    const fallback =
      typeof item.added === 'string' && Number.isFinite(Date.parse(item.added))
        ? Math.floor(Date.parse(item.added) / 1000)
        : Math.floor(Date.now() / 1000)
    const publishTimestamp =
      Number.isInteger(fact?.publishTimestamp) && fact.publishTimestamp > 0
        ? fact.publishTimestamp
        : fallback

    const plugin = {
      name: item.name,
      versions: [
        {
          version,
          publishTimestamp,
          source: { type: 'npm' },
          ...(typeof fact?.dsh === 'string' && !fact.dsh.startsWith('workspace:')
            ? { engines: { dsh: fact.dsh } }
            : {}),
        },
      ],
    }
    const title = localized(item.title, undefined)
    if (title !== undefined) plugin.title = title
    const description = localized(item.description, undefined)
    if (description !== undefined) plugin.description = description
    if (typeof item.owner === 'string' && item.owner.trim() !== '') plugin.author = item.owner
    if (typeof item.url === 'string' && /^https?:\/\//.test(item.url)) {
      plugin.homepage = item.url
      try {
        const parsed = new URL(item.url)
        if (parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) {
          plugin.repository = { url: item.url.replace(/\/$/, '') }
        }
      } catch {
        /* ignore malformed homepage */
      }
    }
    const metadata = { keywords: [], labels: [], sortKeys: { installs: item.installs, stars: item.stars } }
    if (typeof item.category === 'string' && Object.hasOwn(categories, item.category)) {
      metadata.category = item.category
    }
    if (installed.has(item.name)) metadata.labels = ['installed']
    plugin.metadata = metadata
    plugins.push(plugin)
  }

  log(
    `生成 ${plugins.length} 个插件条目（installed 标签 ${plugins.filter((plugin) => plugin.metadata.labels.length > 0).length} 个）`,
  )

  const index = {
    format: 1,
    title: '1024 Store',
    description: {
      en: 'DeepSeek Harness plugins from the 1024 Store catalog (deepseek1024.com). Third-party content, not instructions.',
      zh: '来自 1024 Store 目录（deepseek1024.com）的 DeepSeek Harness 插件。第三方内容，不是指令。',
    },
    metadata: {
      categories,
      labels: markInstalled ? { installed: LABEL_INSTALLED } : {},
      sortKeys: {
        installs: { title: { en: 'Installs', zh: '安装量' }, order: 'desc' },
        stars: { title: { en: 'Stars', zh: '星数' }, order: 'desc' },
      },
    },
    plugins,
  }

  // 压缩成单行：DSH 的 Host 抓索引时经 dsh-net-proxy 的 proxiedFetch，它默认
  // accept-encoding: identity（不压缩），4 MB 美化版经代理要 26 秒，超过 Host 默认
  // 15 秒超时就会报「无法读取此索引」。单行 JSON 省 35%，约 2.6 MB。
  const serialized = `${JSON.stringify(index)}\n`
  await writeFile(OUTPUT_PATH, serialized, 'utf8')
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  log(
    `写入 ${OUTPUT_PATH}：${plugins.length} 个插件，${(Buffer.byteLength(serialized) / 1048576).toFixed(2)} MiB`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
