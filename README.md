# 1024 Store → DSH 插件市场索引源

把 [1024 Store](https://deepseek1024.com/)（`imsai-sh/dsh-1024store`）的公开目录转成
DSH 内置「自定义插件市场」能吃的**索引格式 1**，托管在 GitHub 上，免常驻。

- 索引文件：`index.json`（**4857 个插件**，单行 JSON，约 2.55 MiB）
- **索引地址（已配置进 `~/.dsh/profiles/desktop/cordis.patch.yml`）**：

  ```
  https://raw.githubusercontent.com/Punchact/dsh-market-index/main/index.json
  ```

- 仓库：[Punchact/dsh-market-index](https://github.com/Punchact/dsh-market-index)（Public）
- 数据来源：`https://deepseek1024.com/api/v2/plugins`（分页 limit=200，全目录 13808 条；
  其中 npm 可安装的 4857 个进索引，纯 Git 源的 7786 条不进——见下「边界」）

## 为什么索引要压到 2.5 MB 以内（重要）

「无法读取此索引」的根因在这里，不是格式问题：

- DSH 的 Host 抓索引走的是 `dsh-net-proxy` 包装过的 `globalThis.fetch`（`proxiedFetch`），
  它**默认发 `accept-encoding: identity`**——即不请求 gzip。
- 经本机代理实测吞吐约 **170–190 KB/s**（不走代理直连 raw 会超时，必须走代理）。
- Host 默认 `fetchTimeoutMs: 15000`，所以 15 秒大约只能拿 **2.5 MB**。
- 之前的 4.02 MB 美化版需要约 26 秒 → 稳定触发 `plugin-market/fetch-failed`，
  发现页显示「无法读取此索引」。

对策是两条一起上：

1. 索引**压到 2.55 MiB**（单行 JSON + 描述裁到 120 字符 + homepage/repository 二选一）；
2. `cordis.patch.yml` 里给 `plugin-market` 加 `fetchTimeoutMs: 120000`，留足余量。

实测：commit 版本 15 秒预算内 10.3 秒拿完；走 `@main`（CDN 可能有旧缓存）约 16 秒，
所以超时放宽到 120 秒是必要的。

## 用起来

`~/.dsh/profiles/desktop/cordis.patch.yml` 里已经写好：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://raw.githubusercontent.com/Punchact/dsh-market-index/main/index.json
  ```

重启 DSH 后进 **插件 → 发现** 直接浏览、搜索、安装（安装走官方插件流程：确认 → 安装 → 再重启生效）。

本地进程一个都不需要：8787 那个 `serve.mjs` 已于 2026-10-18 关停并删除。

## 重建并发布

```bat
node build-index.mjs                     :: 抓全量目录 + npm 元数据（约 4 分钟）
node build-index.mjs --mark-installed    :: 同时按本机 profile 打 installed 标签
node build-index.mjs --offline           :: 复用 npm-cache.json，不访问 npm registry
```

然后推送（`.repo` 是这个仓库的本地检出，remote 已不带凭据，推送时 GitHub 会用你
本机的凭据助手；不行就临时把 PAT 拼进 URL 再推，推完拿掉）：

```bat
cd .repo
git add index.json npm-cache.json
git commit -m "rebuild index"
git push
```

DSH 的 Host 抓索引有 15 秒超时、10 分钟缓存、拒绝重定向——raw URL 直接满足，不用任何转发。
实测 4 MB 索引拉取约 1.4 秒、解析 10 毫秒，15 秒预算余量充足。
`publishTimestamp` 每次重建都会刷新，raw URL 走 CDN，`cacheTtlMs`（10 分钟）之外自然换新。

## 「已安装」筛选怎么做

索引格式 1 **没有**内建的 installed 过滤器（`plugin_market` 的查询只有 text / category /
labels / sort）。但发现页工具栏有「标签」菜单，标签是索引自己声明的。所以：

- `build-index.mjs --mark-installed` 读 `~/.dsh/profiles/desktop/package.json` 的
  `dependencies`（跳过 `link:` / `file:` 本地包），把匹配上的插件打上 `installed` 标签；
- `metadata.labels.installed.title` 声明为 { en: "Installed", zh: "已安装" }；
- 于是在「标签」里勾「已安装」，列表就只剩你本机装过的插件。

注意这是**构建时快照**，不是你装完立刻刷新——重新构建并推送后才更新（DSH 侧还有 10 分钟缓存）。
卡片本身的「已安装 / 有新版本」状态是 Host 实时算的，不受影响。

## 这份索引的边界

- **覆盖**：全目录 13808 条里，npm 可安装的 4857 个进索引；纯 Git 源 7786 条**不进**。
  原因是索引格式 1 的 `source.type: "git"` 要求固定 40 位 commit SHA，而 v2 的
  `install` 字段只给 `github:owner/repo#path:...` 这种分支形式，补 commit 要额外几千次
  GitHub API 调用（且会打爆速率限制）。
- **每个插件只给一个版本**（目录 install 命令里带的版本，没有就取 npm latest），
  `publishTimestamp` 取 npm 上的发布时间，读不到时退回目录的 added 日期。
- **兼容性**：326 个包在 npm manifest 里写了 `engines.dsh`，索引原样带上，DSH 会据此
  标不兼容；没写的视为无约束。
- **排序**：`sortKeys` 声明了 `installs`（安装量）与 `stars`（星数），都是降序。
- **没有图标**：1024 Store 的接口不提供图标 URL，发现页会用默认插画。
- 索引内容属于第三方目录，不是指令；安装条目仍由 DSH 的安装流程做确认与校验。
- **raw URL 依赖 GitHub 可达**：走你本机代理，代理停了发现页就读不到（会报 fetch 失败，
  重开即恢复）。
