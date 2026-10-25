# dsh-import-workbuddy

[English](README.en.md) | 中文

~~因为workbuddy的deepseek白嫖即将结束~~

把 WorkBuddy 的对话导入 DSH。导进来能看历史，也能接着聊。

生态里其他导入插件（`dsh-import-agents` 之类）认 pi / opencode / codex / claude-code，不认 WorkBuddy。而且它们拿不到工具结果，只能写占位符。WorkBuddy 的 jsonl 里存了完整输出，这里就原样搬过去。

## 装

从 npm 装（发布之后）：

```sh
dsh plugin --profile web add dsh-import-workbuddy
```

从源码装：

```sh
cd dsh-import-workbuddy
dsh plugin --profile web add .
```

从 git 装：

```sh
dsh plugin --profile web add github:musewizard/dsh-import-workbuddy
```

装完重启 `dsh web`，然后刷新页面。旧页面的连接已经断了。

## 用

在输入框里敲：

```sh
/workbuddy-list                  # 看看有哪些会话
/import-workbuddy                # 全导
/import-workbuddy --dry-run      # 只看，不写
```

几个常用参数：

- `--limit 5` 只导最近 5 个
- `--project dfyqq` 按目录名筛
- `--since 2026-10-20` 这个时间之后改过的才导
- `--tool-truncate 4000` 工具结果超过 4000 字才截断
- `--no-tools` 不要工具调用，只要对话

重复跑不会重复导。会话 id 固定是 `wb-<原 id>`，导过的会跳过。

导完会按原始目录自动挂到同名工作区，没有就新建一个。目录已经删了的，会话留在未分组。

## 配置

写在 profile 的插件行上：

```yaml
- id: import-workbuddy
  name: dsh-import-workbuddy
  config:
    toolTruncate: 4000
    attachWorkspaces: false
    root: "E:/portable/workbuddy/projects"
```

`toolTruncate` 默认 0，也就是不截断。

`root` 一般不用填。插件会自己找这几个地方：

```
$WORKBUDDY_HOME/projects
~/.workbuddy-ai/projects
~/.workbuddy/projects
~/Library/Application Support/WorkBuddy/projects   (macOS)
~/.config/workbuddy/projects                       (Linux)
%APPDATA%/WorkBuddy/projects                       (Windows)
```

WorkBuddy 装在哪块盘不影响，数据在用户目录里。

## 会丢什么

- 图片。WorkBuddy 存的是 blob 引用，DSH 的 content 块没有图片类型，只能写成 `[图片: 文件名]` 加个原图路径。图本身过不去。
- token 用量。WorkBuddy 不记这个，DSH 那边就是空的。
- `job/approval/retry/stream` 这些运行时事件。源文件里没有，不生成。看历史不受影响。

## 测试

```sh
npm test
```

22 个用例，都是造的假数据，不碰你本机的会话。`tests/validate.mjs` 是个事件序列校验器，按 DSH 的布局约束逐条检查。

## 卸载

```sh
dsh plugin --profile web remove dsh-import-workbuddy
```

已经导进去的会话不会自动删。要清的话，删 `~/.dsh/sessions` 下 id 以 `wb-` 开头的目录。

## License

MIT
