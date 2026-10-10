# dsh-prompt-forge

用**文件**定制 DSH 的系统提示词、运行时上下文和每轮提醒。

插件把 Harness 的几处提示词输出接到一组 Markdown 文件上。改文件、保存，下一次模型请求就生效——不用改代码、不用重装、不用重启。

## 它解决什么

DSH 的系统提示词和提醒由 Harness 组装，用户能调的只有 `AGENTS.md`。想改
**系统提示词本身**、想插一段**每轮都出现的提醒**、想把 `AGENTS.md` 外面那圈
包装文字换成自己的说法——都没有入口。

本插件把这四处抽成文件，并保留 Harness 原有的发现、预算、嵌套目录和更新机制。

## 四个文件

全局目录为 `$DSH_HOME/prompts/`，未设置 `DSH_HOME` 时为 `~/.dsh/prompts/`。
项目目录为会话工作目录下的 `.dsh/prompts/`。**项目同名文件覆盖全局文件**。

| 文件 | 作用 |
| --- | --- |
| `system.md` | 整份系统提示词。设置 `complete: true`，组装后**只有这一段**，Harness 原提示词不再拼接 |
| `runtime-context.md` | 追加一段运行时上下文，Harness 保存为 user 角色的上下文快照 |
| `turn-reminder.md` | 每轮开头追加一条 `<system-reminder>`；同轮内文件改动后会在下一步再追加一次 |
| `agents-reminder.md` | 替换官方 `AGENTS.md` 消息的包装文字；**必须包含 `{{instructions}}`** |

`system.md` 里 `{{cwd}}` 会替换成当前会话的绝对工作目录，其他占位符原样保留。

保存后 `fs.watch` 清除缓存，后续模型请求读到新内容。目录还不存在时，插件监视最近的
已有祖先目录，目录建成后自动切过去。单个文件上限 1 MiB。

三种失败都明确报错，不静默降级：文件读取失败、`agents-reminder.md` 缺
`{{instructions}}`、`system.md` 缺失或为空。空的 `runtime-context.md` 和
`turn-reminder.md` 只是不产生文本，不算错误。

项目里放一个**空的** `system.md` 会屏蔽全局文件——此时组装报错，不会悄悄回落到全局。

`agents-reminder.md` 的模板示例：

```text
遵守以下工作区指令。更具体目录中的指令优先于上级目录中的指令。

{{instructions}}
```

## 接管方式与边界

插件保留官方 `AGENTS.md` 的发现、预算、嵌套目录、更新和删除机制。外层
`agent/pre-step` waterfall 在官方生成消息**之后**改写文本，消息的 id、source 和
全部 decision 字段不变。生成的消息仍由 Harness 写入会话日志。

- `<system-reminder>` 标签不会改变消息角色。`AGENTS.md` 提醒仍是 user 角色；
  要进真正的 system 角色，用 `system.md`。
- 已有日志里的提醒不回写。包装模板的改动只影响后续新生成的官方提醒。
- 预算、替换、删除这类语义通知保留；首次 baseline 和 replacement baseline 的
  弱化 intro 被替换，新增目录的首段弱化文字被移除。
- 官方渲染没有可替换的公共接口，所以本插件匹配当前版本的固定包装字符串。
  **DSH 改变这些字符串时需要同步更新。**

`system.md` 用 `complete: true` 是为了保证组装后只剩这一段。工具定义和动态运行时
上下文不受影响，继续由 Harness 提供。

## 安装

```bash
# 从 GitHub
dsh plugin --profile <profile> add github:liu-zhengdong/dsh-prompt-forge

# 本地 checkout（开发用）
dsh plugin --profile <profile> add /abs/path/to/dsh-prompt-forge
```

包声明了 `dsh.bundle.patch`，添加后包名会追加进该 profile 的 `dsh.profile.bundles`。
包本身不用配置，`cordis.patch.yml` 的 `config` 留空。

验证装上了：

```bash
dsh --profile <profile> --dump-config | grep -B2 -A4 prompt-forge
```

应看到一条 `name: dsh-prompt-forge` 的条目。

> 本包未发布到 npm，`add dsh-prompt-forge` 会失败——它不在 npm registry 上。

## 目录速览

```
lib/index.js        插件本体（ESM，无构建步骤）
cordis.patch.yml    bundle 补丁：往 profile 插一条 prompt-forge 条目
```

## 许可

MIT
