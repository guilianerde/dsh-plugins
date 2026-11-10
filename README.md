# dsh-plugins

DeepSeek Harness (DSH) 插件合集。仓库根目录下每个 `plugins/<名字>/` 子目录是一个独立插件，可单独安装、单独开发。

## 插件列表

| 插件 | 说明 |
|---|---|
| [sidebar-browser-control](plugins/sidebar-browser-control/) | 让 Agent 操作 DSH 桌面端内置的侧边栏浏览器；工具严格作用于发起调用的会话，web 模式明确不可用 |

## 安装某个插件

```bash
cd <本仓库>/plugins/sidebar-browser-control
npm install
npm run build:client

dsh plugin --profile desktop add link:<本仓库>/plugins/sidebar-browser-control
```

安装后重启 DSH Desktop。每个插件自己的目录里有更详细的说明与验收步骤。

## 新增插件

在 `plugins/` 下新建目录，按现有插件的 `package.json`（`dsh.client`、`dsh.bundle.patch`）与 `cordis.patch.yml` 结构编写即可；不需要改动仓库其他部分。

## License

MIT
