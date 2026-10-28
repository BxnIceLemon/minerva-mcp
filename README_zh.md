# minerva-mcp

[English](README.md) | **简体中文**

非官方的利兹大学 Minerva（Blackboard Learn Ultra）和 Gradescope 工具，包含一个 MCP 服务器和一个命令行工具。思路参考 [campus-cli](https://github.com/alejooroncoy/campus-cli)：你在真实浏览器里自己登录，工具复用这个会话。Minerva 的数据来自 Blackboard 的 REST API。Gradescope 没有给学生开放的 API，所以用的是它网站本身调用的页面和 JSON 接口。

Minerva 部分只读。Gradescope 还支持上传和重新提交、把以前的某次提交设为当前有效提交、增删小组成员、提交和修改重评申请，整个项目里会改动数据的只有这些操作。

## 安全性

- 登录在系统默认浏览器里进行，支持 Edge、Chrome、Brave 等 Chromium 内核的浏览器。密码和 MFA 都由你自己在浏览器里输入，代码接触不到。
- 浏览器使用 `~/.minerva-mcp/browser-profile` 里的专用配置，和你日常用的配置分开。工具不会读取你平时浏览器里的 cookie 或保存的密码。
- 会话保存在 `~/.minerva-mcp/session.json` 和 `~/.minerva-mcp/gradescope-session.json`，都不在项目目录里。
- 请求只发往 `minerva.leeds.ac.uk` 和 `www.gradescope.com`。文件下载跳转到 Blackboard 的文件域名时，会去掉 cookie。
- Minerva 只发 GET 请求。Gradescope 也只发 GET 请求，例外只有 `submit`、`activate`、`add-member`、`remove-member` 和 `regrade`：
  - 在 CLI 里，这些命令都会先显示要做什么，问你 `[y/N]`，确认后才发送。加 `--dry-run` 则只显示计划，不发送。
  - 在 MCP 里，只有设置了 `GRADESCOPE_ALLOW_WRITE=1`，写工具才会出现。即使出现了，每次调用也必须带 `confirm: true`。工具说明里要求 Agent 先给你看 dry-run 的结果，得到你的同意后才能发送。
- 没有任何遥测。

## 使用

以下命令都要在本文件夹里运行（先 `cd` 进来）：

```bash
npm install
npm run login              # 弹出浏览器，登录 Minerva，成功后窗口自动关闭
npm run login:gradescope   # 登录 Gradescope（选 School Credentials → University of Leeds，或从 Minerva 里点开任意 Gradescope 链接）
npm run check              # 打印你的名字和当前课程列表
```

两个登录命令都会打开你的默认浏览器。Gradescope 会直接跳到利兹大学的单点登录，用的是和 Minerva 同一个 Microsoft 账号。

会话几个小时后就会过期，但一般不需要你重新登录：

- **静默续期**：每次登录都会先在后台的隐藏窗口里尝试。只要 Microsoft 还记得你（“保持登录”），几秒内就能续上，不会弹出窗口。
- **CLI**：`gradescope` 命令发现会话过期时，会先静默续期，再自动重试。如果需要你亲自登录，会先问你要不要打开登录页。
- **Agent**：MCP 服务器提供 `minerva_login` 和 `gradescope_login` 两个工具。其他工具报告会话过期时，Agent（任何 MCP 客户端）可以自己调用它们。需要你操作时，学校的登录页会在默认浏览器里打开，Agent 会提示你完成登录。

## Gradescope 命令行

在本文件夹里运行一次 `npm link`，之后在任何目录都能用 `gradescope` 命令。也可以直接运行 `node src/cli.js`。

```bash
gradescope login                                  # 登录（等同于 npm run login:gradescope）
gradescope upcoming --days 14                     # 本学期快到期的作业
gradescope assignments COMP3620                   # 每个作业的状态、分数和截止时间
gradescope grades COMP3620                        # 各项分数和总分
gradescope submit COMP3620 Perceptron perceptron.py --wait   # 上传，并等待 autograder 跑完
gradescope results COMP3620 Perceptron            # autograder 每个测试的结果和输出
gradescope comments COMP3620 Perceptron           # rubric、评语、重评对话
gradescope history COMP3620 Perceptron            # 你对这个作业的所有提交
gradescope activate COMP3620 Perceptron 123456789 # 把以前的某次提交设为当前有效提交
gradescope members COMP2850 "Team Project"         # 小组提交里有哪些人
gradescope add-member COMP2850 "Team Project" "Ada Lovelace"   # 加入同学（姓名、邮箱或 ID）
gradescope remove-member COMP2850 "Team Project" me             # 退出小组（或写别人的名字）
gradescope regrade COMP3620 "Lab 2" 1.3 -m "我的答案符合题目 (b) 部分的要求"
```

- `<course>` 可以写课程编号，也可以写模块代码（如 `COMP3620`）。
- `<assignment>` 可以写作业 ID，也可以写作业标题里唯一的一段文字。
- 任何命令加 `--json` 都会输出原始 JSON。其他用法看 `gradescope --help`。

`submit` 支持 Gradescope 的三种上传方式：

- **代码作业**：可以上传任意多个文件。`.zip` 会先在本地解压，再带着目录路径逐个上传，和网页上传完全一样（会跳过 `__MACOSX/` 和 `.DS_Store`）。如果作业确实要求交 zip 本身，加 `--keep-zip`。
- **PDF 作业**：只能上传一个 PDF。如果是不定页数的 PDF 作业，上传后还要在浏览器里给每道题分配页面，命令会输出对应的链接。
- **文档作业**：只能上传一个文件。

在线作答的作业（测验）只能在浏览器里完成。

## 注册到 MCP 客户端

大多数 MCP 客户端都支持下面这种 stdio 服务器的 JSON 配置（写在客户端的 MCP 设置文件里，或者项目里的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "minerva": {
      "command": "node",
      "args": ["<本文件夹的绝对路径>/src/server.js"]
    }
  }
}
```

如果也要开放 Gradescope 的写工具，在这一项里加上 `"env": { "GRADESCOPE_ALLOW_WRITE": "1" }`。改完后重启客户端。

## 注册到 Codex

```bash
codex mcp add minerva -- node "<本文件夹的绝对路径>/src/server.js"
```

也可以写进 `~/.codex/config.toml`：

```toml
[mcp_servers.minerva]
command = "node"
args = ["<绝对路径>/src/server.js"]
tool_timeout_sec = 300   # 等待登录或等 autograder 跑完，可能超过 Codex 默认的 60 秒
# env = { GRADESCOPE_ALLOW_WRITE = "1" }   # 只有要让 Codex 用 Gradescope 写工具时才加
```

改完后重启 Codex。工具在 Codex 里的用法和在其他 MCP 客户端里一样。保留默认的 60 秒超时也能用，只是 `minerva_login` / `gradescope_login` 会更早返回 `waitingForUser`，调用 `gradescope_get_results` 时 `waitSeconds` 要设在 60 以内。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `minerva_status` | 检查是否已登录，以及会话何时过期 |
| `minerva_login` | 续期或重新登录 Minerva；需要你操作时会打开默认浏览器 |
| `minerva_whoami` | 当前用户 |
| `minerva_list_courses` | 课程列表，可按代码或名称筛选 |
| `minerva_list_announcements` | 某门课的公告 |
| `minerva_list_contents` | 课程大纲 / 文件夹内容 |
| `minerva_get_content` | 单个内容的全文、附件和页面内嵌文件列表 |
| `minerva_download_attachment` | 下载附件或内嵌文件到 `~/Downloads/minerva` |
| `minerva_my_grades` | 成绩册：截止日期、提交状态、分数、反馈 |
| `minerva_upcoming_deadlines` | 扫描所有当前课程，列出 N 天内的截止项 |
| `minerva_calendar` | 日历事件 |
| `minerva_api_get` | 直接 GET 任意 `/learn/api/public/` 接口 |
| `gradescope_status` | 检查 Gradescope 是否已登录 |
| `gradescope_login` | 通过 Leeds 单点登录续期或重新登录 Gradescope；需要时会打开默认浏览器 |
| `gradescope_list_courses` | Gradescope 课程列表（按学期，最新在前） |
| `gradescope_list_assignments` | 某门课的作业：提交状态、分数、发布 / 截止 / 迟交截止时间 |
| `gradescope_upcoming` | 本学期 N 天内要交的 Gradescope 作业 |
| `gradescope_grades` | 某门课所有作业的分数和总分 |
| `gradescope_get_submission` | 一次提交的全部信息：分数、rubric、评语、批注、重评对话、autograder |
| `gradescope_get_results` | autograder 测试结果；`waitSeconds` 可以等它跑完 |
| `gradescope_get_comments` | 老师的反馈，以及重评申请和老师的回复 |
| `gradescope_list_submissions` | 某个作业的所有提交，标出当前有效的那次，以及哪些可以切换 |
| `gradescope_list_group_members` | 小组提交里有哪些人、人数上限、还能不能改 |
| `gradescope_submit` | 上传或重新提交（需要 `GRADESCOPE_ALLOW_WRITE=1`） |
| `gradescope_activate_submission` | 把以前的某次提交设为当前有效提交（需要 `GRADESCOPE_ALLOW_WRITE=1`） |
| `gradescope_add_group_members` | 把同学加入小组提交（需要 `GRADESCOPE_ALLOW_WRITE=1`） |
| `gradescope_remove_group_member` | 移除小组成员，或自己退出（需要 `GRADESCOPE_ALLOW_WRITE=1`） |
| `gradescope_request_regrade` | 提交或修改重评申请（需要 `GRADESCOPE_ALLOW_WRITE=1`） |

## 环境变量

- `MINERVA_BROWSER`：登录用的浏览器，可以填可执行文件路径，也可以填通道名（`msedge`、`chrome`）。默认用系统默认浏览器。如果默认浏览器是无法自动化的 Firefox 或 Safari，会改用已安装的 Edge 或 Chrome。
- `MINERVA_MCP_HOME`：会话目录，默认 `~/.minerva-mcp`
- `MINERVA_DOWNLOAD_DIR`：下载目录，默认 `~/Downloads/minerva`
- `GRADESCOPE_ALLOW_WRITE`：设为 `1` 才会注册 MCP 的写工具。CLI 不受这个变量影响。
- `GRADESCOPE_SSO_PATH`：Gradescope 学校单点登录的路径，默认是利兹大学的。设为空值则改用 Gradescope 的普通登录页。
- `MINERVA_NO_AUTO_LOGIN`：设为 `1` 后，CLI 不会在会话过期时自动续期。

## 已知限制

- 2026-10-16 和 2026-10-21 用学生账号测过：课程、公告、大纲、附件下载、成绩册、截止日期、日历都能用。成绩册只列出已经评分的项目，没评分的项目 `graded` 为 `false`。
- Gradescope 的读取功能在真实的代码、PDF、在线和小组作业上都测过。所有写操作都只跑过 dry-run，包括各种拒绝情况（作业已关闭、小组已满或已锁定）。请求格式是照着 Gradescope 自己的网页代码写的，但还没有真正发送过。
- Gradescope 不允许学生删除提交。想“撤回”一次提交，可以重新提交，或者把以前的某次提交设为当前有效提交。
- 手上没有带老师批注的样本，所以批注文字的提取是尽量兼容的写法，不保证完整。
- Gradescope 作业在 Minerva 里只有截止日期，提交状态和分数请用 `gradescope_*` 工具查。
- Minerva 和 Gradescope 工具的 `courseId` 都可以写短代码（如 `COMP3620`），会自动匹配最新一年的那门课。
- Gradescope 部分依赖网站的内部实现，Gradescope 改版后可能需要跟着更新。
- Turnitin、Panopto 等第三方 LTI 工具里的内容拿不到。
- 请合理使用，遵守学校的 IT 使用政策和学术诚信规定。

## 参与贡献

请看 [CONTRIBUTING.md](CONTRIBUTING.md)。`main` 分支受保护：所有改动都要走 PR，并通过 CI（`npm test`）。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[ISC](LICENSE)
