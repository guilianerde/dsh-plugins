# dsh-permanent-session-delete

在 DSH Desktop 的会话菜单中永久删除本地会话及其消息记录。该操作不可撤销。

## 安装

要求 DSH Desktop `0.2.2-rc.1` 或更高版本。

从 npm 安装：

```bash
dsh plugin --profile desktop add dsh-permanent-session-delete
```

从 GitHub 安装：

```bash
dsh plugin --profile desktop add \
  'github:guilianerde/dsh-plugins#main&path:/plugins/dsh-session-delete'
```

安装后重启 DSH Desktop。

## 使用

1. 在左侧会话列表中找到目标会话。
2. 打开该会话的行菜单。
3. 选择“永久删除会话”。
4. 阅读确认对话框并确认删除。

删除当前打开的会话后，插件会尝试切换到新会话。

## 安全行为

- 先取消运行中的 Agent，等待其停止，再刷新会话持久化状态。
- 仅删除已核对会话 ID、JSONL 文件名和规范化目录结构的本地会话目录。
- 如果路径、符号链接或会话身份无法验证，则拒绝删除。
- 删除成功后才通知 DSH 更新会话列表。

## 限制

- 仅支持本地 JSONL 会话存储；不符合预期路径结构的会话会拒绝删除。
- 不删除项目文件、工作区或其他会话。
- 删除后无法从插件界面恢复。

## 开发与发布检查

```bash
npm test
npm pack --dry-run --json
```
