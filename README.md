# @itsyuyi/dsh-workspace-search

DeepSeek Harness (DSH) plugin for **workspace session search** — a sidebar-foot “Search sessions” action that opens a keyword search palette over the whole workspace.

为 DeepSeek Harness 提供**工作区会话搜索**能力——侧栏底部新增「搜索会话」入口，打开全局搜索面板，对工作区内所有会话进行关键字搜索。

## Features / 功能

- **Three search scopes, one keyword** — session **titles/folders** (instant, client-side), the **user's questions** (`user/message`), and the **assistant's replies** (`assistant/message`); tool traffic matches too. Every result row is tagged with the scope it matched: 名称匹配 / 问题匹配 / 回复匹配 / 内容匹配.
  一个关键字覆盖三个范围——会话**名称/目录**（客户端即时匹配）、**用户提问**（`user/message`）、**回复内容**（`assistant/message`），工具交互文本同样可命中；每条结果都标注命中范围（名称/问题/回复/内容匹配）。
- **Overlay search palette** — type to search with debouncing and cancellation; Enter opens, Esc closes, ↑↓ move the selection (the selected row is highlighted and auto-scrolled into view).
  悬浮搜索面板——输入即搜（防抖 + 取消过期请求）；Enter 打开、Esc 关闭、↑↓ 选择（选中行高亮并自动滚入视野）。
- **Jump to the match** — opening a content hit reveals the sidebar session row (expanding a collapsed workspace group when needed), loads history through the matched event, and centers the transcript on the matching text with a flash highlight.
  命中即定位——打开内容命中时会滚动侧栏到对应会话行（必要时自动展开折叠的工作区分组），把历史加载到命中事件处，并在会话内居中定位到匹配文本并闪烁高亮。
- **Works out of the box** — content search answers through this plugin's own Host route: it uses the ranked full-text index when the deployment enables it, otherwise it falls back to a bounded corpus scan (500 newest sessions / 8 s budget, cancellable), so it works even where `session-query-sqlite` keeps `openAt: never` (the default, which disables the shipped sidebar's content search).
  开箱即用——内容检索走插件自带的宿主路由：部署启用了全文索引则走排序检索，否则回退到有界的语料扫描（最新 500 个会话 / 8 秒预算 / 可取消），因此在 `session-query-sqlite` 保持 `openAt: never`（默认，会禁用内置侧栏的内容搜索）的环境下同样可用。
- **Localized & themed** — UI copy follows the host language (中文 / English), styles use `--dsw-alias-*` theme tokens only, light & dark.
  本地化与主题——文案跟随宿主语言，样式仅用 `--dsw-alias-*` 主题 token，明暗主题自适应。
- **Shortcut** — Cmd/Ctrl+Shift+K opens the palette (web: Cmd/Ctrl+Alt+Shift+K, following the host's web-modifier convention; Cmd/Ctrl+K remains the shipped sidebar search).
  快捷键——⌘/Ctrl+Shift+K 打开面板（Web 端为 ⌘/Ctrl+Alt+Shift+K，沿用宿主 Web 修饰键惯例；⌘/Ctrl+K 仍属内置侧栏搜索）。

## Requirements / 环境要求

- DeepSeek Harness (web surface), DSH `0.2.x` generation (`@deepseek-ai/cordis` 4.x)
- Node `^22.19.0 || >=24.0.0`

## Install / 安装

In any DSH agent session, ask the agent (or use the plugin manager) to install from npm:
在任意 DSH 会话里让 Agent 执行（或通过插件管理器）从 npm 安装：

```text
plugin_manager install_bundle @itsyuyi/dsh-workspace-search
```

Or from a local checkout / 或从本地目录安装：

```text
plugin_manager install_bundle /path/to/dsh-workspace-search
```

## Notes / 说明

- **Restart after host-half changes** — Node caches ESM resolution per process, so after upgrading the plugin's Host half (`index.js`), restart `dsh web` once; client-only changes apply after a page refresh.
  宿主半边（`index.js`）升级后需重启一次 `dsh web`（Node 进程内会缓存模块解析）；仅客户端改动刷新页面即可。
- **Limitations / 已知边界** — the sidebar reveal needs the workspace browser's row to be renderable (it expands collapsed groups itself); the in-conversation text locate is best-effort — text that the transcript renders differently (folded tool output, heavy markdown) may not be found, in which case the session still opens with a toast notice.
  侧栏定位依赖行可渲染（会自动展开折叠分组）；会话内文本定位为尽力而为——界面渲染与索引文本差异较大时（折叠的工具输出、重度 markdown）可能定位不到，此时仍会打开会话并以提示条告知。

## License

MIT © 2026 itsyuyi
