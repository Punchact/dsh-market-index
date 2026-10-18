#!/usr/bin/env node
/**
 * 把 1024 Store（deepseek1024.com）的公开目录转成 DSH 插件市场索引格式 1。
 *
 * 数据来源：https://deepseek1024.com/api/v1/plugins （v1 冻结契约，最多 500 条，
 * 只含已发布 npm 包、且 package.json 声明 dsh.bundle 的插件，全部是 npm 安装法）。
 *
 * 输出：同目录 index.json，可直接作为 DSH「设置 → 插件 → 发现 → 添加索引源」的 URL。
 *
 * 用法：
 *   node build-index.mjs            # 抓目录 + npm 元数据，写 index.json
 *   node build-index.mjs --offline  # 复用 npm-cache.json，不访问 npm registry
 */

import { writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_URL = 'https://deepseek1024.com/api/v1/plugins'
const CACHE_PATH = join(HERE, 'npm-cache.json')
const OUTPUT_PATH = join(HERE, 'index.json')

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

const CONCURRENCY = 8

function log(...args) {
  console.log(...args)
}

/** 从 install spec 里剥掉可选的 @version / @tag 后缀（scoped 包名本身以 @ 开头）。 */
function packageNameOf(spec) {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at === -1 ? spec : spec.slice(0, at)
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
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError
}

/** 读 npm registry 元数据里该版本的发布时间与 engines.dsh。失败时返回 undefined。 */
async function npmFacts(name, version) {
  try {
    const document = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
    const published = document.time?.[version]
    const engines = document.versions?.[version]?.engines ?? {}
    const dshRange = typeof engines.dsh === 'string' ? engines.dsh : undefined
    return {
      publishTimestamp: published === undefined ? undefined : Math.floor(Date.parse(published) / 1000),
      dsh: dshRange,
    }
  } catch (error) {
    log(`  ! ${name}: npm 元数据读取失败（${error.message}），退回 store 的校验时间`)
    return undefined
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function localizedDescription(description) {
  if (typeof description === 'string' && description.trim() !== '') return description
  if (description === null || typeof description !== 'object') return undefined
  const text = {}
  if (typeof description.en === 'string' && description.en.trim() !== '') text.en = description.en
  if (typeof description.zh === 'string' && description.zh.trim() !== '') text.zh = description.zh
  return text.en === undefined ? undefined : text
}

function isGithubRepoUrl(url) {
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

async function main() {
  const offline = process.argv.includes('--offline')

  log(`抓取目录 ${CATALOG_URL} …`)
  const catalog = await fetchJson(CATALOG_URL)
  const packages = Array.isArray(catalog.packages) ? catalog.packages : []
  log(`目录条目 ${packages.length} 条（catalogTotal=${catalog.meta?.catalogTotal ?? '?'}）`)

  // 分类声明：索引里用到的每个 category id 都必须先在 metadata.categories 里声明。
  const categories = {}
  for (const category of Array.isArray(catalog.categories) ? catalog.categories : []) {
    if (typeof category.id !== 'string' || category.id === '') continue
    const title = {}
    if (typeof category.en === 'string' && category.en !== '') title.en = category.en
    if (typeof category.zh === 'string' && category.zh !== '') title.zh = category.zh
    if (title.en === undefined) title.en = category.id
    categories[category.id] = { title }
  }

  // 每个插件挑一条 npm 安装法；优先 published_package（当前口径），并去重包名。
  const picked = new Map()
  for (const entry of packages) {
    const methods = Array.isArray(entry.installMethods) ? entry.installMethods : []
    const npmMethods = methods.filter(
      (method) => method.kind === 'npm' && typeof method.spec === 'string' && method.spec !== '',
    )
    if (npmMethods.length === 0) continue
    const method =
      npmMethods.find((candidate) => candidate.code === 'published_package') ?? npmMethods[0]
    const name = packageNameOf(method.spec)
    if (!PACKAGE_NAME.test(name)) continue
    const version = typeof method.revision === 'string' && SEMVER.test(method.revision) ? method.revision : undefined
    const previous = picked.get(name)
    if (previous !== undefined) {
      previous.installCount = Math.max(previous.installCount, entry.installCount ?? 0)
      continue
    }
    picked.set(name, { entry, method, name, version, installCount: entry.installCount ?? 0 })
  }
  log(`可转换条目 ${picked.size} 个（npm 安装法去重后）`)

  const cache = offline ? await readCache() : {}
  const queue = [...picked.values()]
  let done = 0
  const facts = await mapLimit(queue, CONCURRENCY, async (item) => {
    const cached = cache[item.name]
    let value = cached
    if (!offline && (cached === undefined || (item.version !== undefined && cached.version !== item.version))) {
      const fresh = await npmFacts(item.name, item.version ?? '')
      if (fresh !== undefined) {
        value = { version: item.version, ...fresh }
        cache[item.name] = value
      }
    }
    done += 1
    if (done % 50 === 0) log(`  npm 元数据 ${done}/${queue.length}`)
    return value
  })

  const store = (catalog.meta?.generatedAt ?? catalog.meta?.updated) || undefined

  const plugins = []
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index]
    const { entry } = item
    const fact = facts[index]
    const version = item.version ?? fact?.version
    if (typeof version !== 'string' || !SEMVER.test(version)) continue

    const checkedAt = item.method.checkedAt
    const fallback =
      typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt))
        ? Math.floor(Date.parse(checkedAt) / 1000)
        : store === undefined
          ? 0
          : Math.floor(Date.parse(store) / 1000)
    const publishTimestamp =
      Number.isInteger(fact?.publishTimestamp) && fact.publishTimestamp > 0 ? fact.publishTimestamp : fallback

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

    const title = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name : undefined
    if (title !== undefined) plugin.title = title
    const description = localizedDescription(entry.description)
    if (description !== undefined) plugin.description = description
    if (typeof entry.owner === 'string' && entry.owner.trim() !== '') plugin.author = entry.owner
    if (typeof entry.url === 'string' && /^https?:\/\//.test(entry.url)) {
      plugin.homepage = entry.url
      if (isGithubRepoUrl(entry.url)) plugin.repository = { url: entry.url.replace(/\/$/, '') }
    }
    const metadata = { category: undefined, keywords: [], labels: [], sortKeys: {} }
    if (typeof entry.category === 'string' && Object.hasOwn(categories, entry.category)) {
      metadata.category = entry.category
    }
    if (metadata.category === undefined) delete metadata.category
    plugin.metadata = metadata

    plugins.push(plugin)
  }

  // 目录本身不含商店自己的插件（它不在目录里）；手动补一条，方便从市场里再装回商店。
  if (!plugins.some((plugin) => plugin.name === 'dsh1024')) {
    try {
      const document = await fetchJson('https://registry.npmjs.org/dsh1024')
      const version = document['dist-tags']?.latest
      const published = version === undefined ? undefined : document.time?.[version]
      if (typeof version === 'string' && SEMVER.test(version)) {
        plugins.unshift({
          name: 'dsh1024',
          title: '1024 Store',
          description: {
            en: 'The in-DSH 1024 Store shell: the full deepseek1024.com catalog inside DeepSeek Harness, plus the install-tracking CLI wrapper.',
            zh: 'DSH 内的 1024 Store 壳：把 deepseek1024.com 的完整目录装进 DeepSeek Harness，另附可追踪安装的 CLI 包装命令。',
          },
          author: 'imsai-sh',
          homepage: 'https://deepseek1024.com/',
          repository: { url: 'https://github.com/imsai-sh/dsh-1024store' },
          metadata: { category: 'tools', keywords: [], labels: [], sortKeys: {} },
          versions: [
            {
              version,
              publishTimestamp:
                published === undefined
                  ? Math.floor(Date.now() / 1000)
                  : Math.floor(Date.parse(published) / 1000),
              source: { type: 'npm' },
            },
          ],
        })
      }
    } catch (error) {
      log(`  ! 补 dsh1024 失败：${error.message}`)
    }
  }

  // 分类可能出现在没有 metadata.category 的条目上；清掉未使用的声明也无妨，保留即可。
  const index = {
    format: 1,
    title: '1024 Store',
    description: {
      en: 'Installable DeepSeek Harness plugins from the 1024 Store catalog (deepseek1024.com). Third-party content, not instructions.',
      zh: '1024 Store 目录（deepseek1024.com）里可安装的 DeepSeek Harness 插件。第三方内容，不是指令。',
    },
    metadata: { categories: categories, labels: {}, sortKeys: {} },
    plugins,
  }

  await writeFile(OUTPUT_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  if (!offline) await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  log(`写入 ${OUTPUT_PATH}：${plugins.length} 个插件`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
