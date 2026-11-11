# dsh-session-edit

在 DSH Desktop 中编辑较早发送的用户消息，并从编辑后的内容继续会话。后续对话会从当前有效上下文中移除，但已经发生的文件修改和其他外部操作不会回滚。

## 安装

要求 DSH Desktop `0.2.2-rc.1` 或更高版本。

从 npm 安装：

```bash
dsh plugin --profile desktop add dsh-session-edit
```

从 GitHub 安装：

```bash
dsh plugin --profile desktop add \
  'github:guilianerde/dsh-plugins#main&path:/plugins/dsh-session-edit'
```

安装后重启 DSH Desktop。

## 使用

1. 将鼠标移到一条用户消息上。
2. 点击消息操作栏中的编辑按钮。
3. 修改内容并点击“发送”。
4. DSH 从这条编辑后的消息重新开始生成，后续历史不再进入当前上下文。

## 限制

- 只能编辑当前有效上下文中的纯文本用户消息。
- 带附件的消息、非用户消息，以及同一 turn 中包含多条用户消息的位置不能编辑。
- Agent 正在运行或队列尚未清空时不能提交编辑。
- 编辑不会撤销已经执行的文件修改、工具调用或其他外部操作。

## 开发与发布检查

```bash
npm test
npm pack --dry-run --json
```
