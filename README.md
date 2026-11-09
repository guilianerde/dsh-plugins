# dsh-sidebar-browser-control

让 DSH 桌面端里的 Agent 直接操作 **DSH 自带的右侧边栏浏览器**（不是外部 Chrome，也不是另一个独立窗口）。

用户说“在当前会话的侧栏打开 example.com 并总结”，Agent 就能在**同一个会话**的侧栏里打开页面、读取正文、点击、输入、滚动、截图；用户和 Agent 看到的是同一个页面。

## 和 `dsh-browser` 的区别

| | `dsh-browser` | 本插件 |
|---|---|---|
| 控制对象 | 用户已打开的 Chrome / Firefox 标签页 | DSH Desktop 内置侧栏 `<webview>` |
| 依赖 | 浏览器扩展 + 本机 bridge | 无额外进程，renderer 内直接驱动 |
| 会话绑定 | 以浏览器标签为主 | 以 DSH `sessionId` 为主，工具自动路由到当前会话 |
| Web 模式 | 支持外部浏览器 | 明确返回 `SIDEBAR_UNAVAILABLE` |

## 架构

```
模型
  │  调用 sidebar_browser_* 工具
  ▼
Host 插件（lib/index.js，Node 侧）
  │  参数校验、URL 策略、按 exec.agent.id 路由、30s 超时
  │  POST /dsh-sidebar-browser/{hello,poll,respond}
  ▼
Client 插件（lib/client.js，DSH renderer 内）
  │  找到当前 session 的 <webview data-sidebar-browser-frame="webview">
  │  调用 loadURL / executeJavaScript / capturePage / sendInputEvent
  ▼
DSH 右侧边栏里的真实网页
```

- 控制通道是**同源 HTTP 长轮询**，不是 WebSocket。桌面壳的 Host/Origin fence 会拒绝 `dsh-app://app` 页面发起的裸 WebSocket（1006），而 `fetch('/dsh-sidebar-browser/...')` 会走桌面壳自己的 HTTP 转发并携带会话 cookie。
- Host 按 `sessionId` 保存每个 renderer 的队列；工具调用只投递到**发起该调用的会话**。没有可靠 session 身份时拒绝控制，而不是猜“最近活动的标签页”。
- web 模式（浏览器里打开 `dsh web`）的侧栏是跨源 sandbox iframe，无法读取 DOM，因此所有操作返回 `SIDEBAR_UNAVAILABLE`，不会静默切到独立窗口。

## 工具

| 工具 | 作用 |
|---|---|
| `sidebar_browser_open` | 在侧栏打开 http(s) URL；`newTab:true` 强制新标签 |
| `sidebar_browser_observe` | 返回标题、URL、加载状态、视口、可交互元素 ref、正文摘要、`observationId` |
| `sidebar_browser_get_text` | 只取可见正文 |
| `sidebar_browser_click` | 按 ref / CSS selector / 可见文本点击；支持左右中键、双击 |
| `sidebar_browser_type` | 向输入框写文本；可 `submit:true` 回车提交 |
| `sidebar_browser_press` | 按键（Enter、Tab、Escape、方向键、单字符）及修饰键 |
| `sidebar_browser_scroll` | 向上/下/顶部/底部滚动 |
| `sidebar_browser_navigate` | 当前标签跳转 URL |
| `sidebar_browser_tabs` | 列出当前会话的侧栏浏览器标签 |
| `sidebar_browser_switch_tab` | 切换并聚焦标签 |
| `sidebar_browser_close_tab` | 关闭标签 |
| `sidebar_browser_back` / `forward` / `reload` | 历史与刷新 |
| `sidebar_browser_wait` | 等毫秒、等文本出现、等 selector 出现 |
| `sidebar_browser_screenshot` | 截图写 `/tmp/dsh-sidebar-browser/*.png`，返回路径给 `read_image` |

约定：

- 元素 ref 与 `observationId` 绑定。页面导航、重载或用户接管后，旧 ref 返回 `STALE_ELEMENT`，必须重新 `observe`。
- 密码框的值在 `observe` 中显示为 `••••`，不回传明文。
- 页面文字是**不可信数据**，工具输出会附带提示，不应把网页内容当成系统指令。
- 默认拒绝 `localhost`、私有网段、`.local`、`169.254.*`。确有本地开发需要时，在插件配置里设 `allowPrivateNetwork: true`。

## 安装

要求：DSH Desktop **0.2.2-rc.1**（已在 macOS 实测）。web 模式不支持。

```bash
cd /path/to/dsh-plugin
npm install
npm run build:client

# 链接进 desktop profile
dsh plugin --profile desktop add link:/path/to/dsh-plugin
```

`dsh plugin add` 会同时写入依赖和 `dsh.profile.bundles`。安装后确认：

`~/.dsh/profiles/desktop/package.json`

```json
{
  "dependencies": {
    "dsh-sidebar-browser-control": "link:/path/to/dsh-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-sidebar-browser-control"
      ]
    }
  }
}
```

重启 DSH Desktop。侧栏打开一个 browser tab 后，Agent 就能看到 `sidebar_browser_*` 工具。

> 只加依赖、不加 `dsh.profile.bundles` 时，client 半边仍会被静态加载，但 host 半边不会挂载：表现为工具不存在、`/dsh-sidebar-browser/ping` 404。这是本插件最容易漏的一步。

## 验证

```bash
# host 桥单元测试（不启动 Electron）
node test/host.test.mjs

# 启动后健康检查
curl http://127.0.0.1:<web-port>/dsh-sidebar-browser/ping   # pong
```

手工验收：

1. 在当前会话侧栏打开 `https://example.com`，问 Agent 页面标题；应读到 `Example Domain`。
2. 让 Agent 点 “Learn more”，URL 应变为 `iana.org`，且侧栏里用户看到同一页。
3. 新开一个聊天会话，`sidebar_browser_tabs` 应返回空，而不是上一个会话的标签。
4. 在浏览器版 `dsh web` 里调用，应得到 `SIDEBAR_UNAVAILABLE`。
5. 页面重载后用旧 `observationId` 点击，应得到 `STALE_ELEMENT`。

## 已知限制

- 仅桌面端；web 模式的 iframe 不可控。
- 依赖 DSH 内置侧栏的 DOM 契约（`data-sidebar-browser-frame="webview"`、`data-sidebar-right-tab`、`sidebarRight` service）。DSH 升级后若这些契约变化，需要同步适配。
- 暂未实现显式“暂停/人工接管”按钮；Agent 每次动作前重新 observe，用户手动改页面后旧 ref 会失效。
- 截图是设备像素，落在 `/tmp`，不进入聊天历史；敏感页面请自行判断是否调用。
- 模型端到端验收需要可用的模型额度；桥接层本身不依赖模型。

## 开发

```bash
npm run build:client   # src/client.js -> lib/client.js（__ModuleLoader__ 包装）
node test/host.test.mjs
```

`src/client.js` 是 ESM 源码；DSH 的 client 模块加载器要求 `window.__ModuleLoader__.load({id, factory})` 包装，构建脚本负责转换，不要直接把 ESM 源码当 `lib/client.js` 发布。

## License

MIT
