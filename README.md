# dsh-plugins

DeepSeek Harness (DSH) 插件合集。仓库根目录下每个 `plugins/<名字>/` 子目录是一个独立插件，可单独安装、单独开发。

## 插件列表

| 插件 | 说明 |
|---|---|
| [sidebar-browser-control](plugins/sidebar-browser-control/) | 让 Agent 操作 DSH 桌面端内置的侧边栏浏览器；工具严格作用于发起调用的会话，web 模式明确不可用 |
| [dsh-session-edit](plugins/dsh-session-edit/) | 编辑历史用户消息，并从编辑后的内容继续会话 |
| [dsh-permanent-session-delete](plugins/dsh-session-delete/) | 从会话菜单中永久删除本地会话及消息记录 |

## 从 npm 安装

```bash
dsh plugin --profile desktop add dsh-session-edit
dsh plugin --profile desktop add dsh-permanent-session-delete
```

## 从 GitHub 安装

```bash
dsh plugin --profile desktop add \
  'github:guilianerde/dsh-plugins#main&path:/plugins/dsh-session-edit'

dsh plugin --profile desktop add \
  'github:guilianerde/dsh-plugins#main&path:/plugins/dsh-session-delete'
```

安装后重启 DSH Desktop。固定版本时，将 `main` 替换为 tag 或 commit。

## 源码与本地开发

`sidebar-browser-control` 当前仍按源码构建后链接：

```bash
cd plugins/sidebar-browser-control
npm install
npm run build:client

dsh plugin --profile desktop add link:<本仓库>/plugins/sidebar-browser-control
```

其他本地开发插件也可以直接链接：

```bash
dsh plugin --profile desktop add link:<本仓库>/plugins/dsh-session-edit
dsh plugin --profile desktop add link:<本仓库>/plugins/dsh-session-delete
```

每个插件自己的 README 包含使用限制、安装命令和验证步骤。

## 新增插件

在 `plugins/` 下新建目录，按现有插件的 `package.json`（`dsh.client`、`dsh.bundle.patch`）与 `cordis.patch.yml` 结构编写即可。每个子目录独立发布，不需要改动仓库根目录的包配置。

## License

MIT
