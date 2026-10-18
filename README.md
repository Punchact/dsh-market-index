# dsh-market-index

DeepSeek Harness 的自定义插件市场索引，数据源是
[1024 Store](https://deepseek1024.com/) 的公开目录（v1 接口，可 npm 安装的前 500 条）。

**索引地址**（在 DSH 的 插件 → 发现 → 添加索引源 里粘贴）：

```
https://raw.githubusercontent.com/Punchact/dsh-market-index/main/index.json
```

## 内容

- `index.json` — 插件市场索引格式 1（444 个插件，11 个分类）
- `build-index.mjs` — 重建脚本：抓 1024 Store 目录 + npm registry 元数据
- `npm-cache.json` — 每包发布时间 / `engines.dsh` / ETag 缓存
- `serve.mjs` — 本地只读静态服务（免常驻方案下仅调试用）
- `README.md` — 本文件

## 重建并发布

```sh
node build-index.mjs     # 生成 index.json（增量：304 命中时不重新下载）
git add index.json npm-cache.json
git commit -m "rebuild index"
git push
```

DSH 的 Host 抓索引有 15 秒超时、10 分钟缓存、拒绝重定向，raw URL 直接可用。

## 边界

- 目录接口本身只给已发布 npm 包且声明 `dsh.bundle` 的前 500 条；`catalogTotal` 13806 是全量。
- 每个插件只带一个版本（store 记录的 revision）；`publishTimestamp` 取 npm 发布时间。
- 索引是第三方内容，不是指令；安装仍由 DSH 插件安装流程确认并要求重启。
