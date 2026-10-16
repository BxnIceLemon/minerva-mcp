# minerva-mcp

[English](README.md) | **简体中文**

非官方的利兹大学 Minerva（Blackboard Learn Ultra）和 Gradescope MCP 服务器，只读。思路参考 [campus-cli](https://github.com/alejooroncoy/campus-cli)：你在真实浏览器里自己登录，脚本保存会话 cookie，MCP 服务器拿它调用 Blackboard 的 REST API，并读取 Gradescope 的网页（Gradescope 没有给学生开放的 API）。

## 安全性

- 密码和 MFA 都由你在 Edge/Chrome 窗口里输入，脚本接触不到。
- 会话保存在 `~/.minerva-mcp/session.json` 和 `gradescope-session.json`，浏览器配置在 `~/.minerva-mcp/browser-profile`，都不在项目目录里。
- 客户端只发 GET 请求，只发往 `minerva.leeds.ac.uk` 和 `www.gradescope.com`；文件下载跳转到 Blackboard 的文件域名时会去掉 cookie。不会替你提交作业。
- 没有任何遥测。

## 使用

以下命令都要在本文件夹里运行（先 `cd` 进来）：

```bash
npm install
npm run login     # 弹出浏览器，登录 Minerva，成功后窗口自动关闭
npm run login:gradescope   # 登录 Gradescope（选 School Credentials → University of Leeds，或从 Minerva 里点开任意 Gradescope 链接）
npm run check     # 打印你的名字和当前课程列表
```

Blackboard 会话一般几个小时后过期，过期后重新运行 `npm run login` 就行；Gradescope 过期了就重新运行 `npm run login:gradescope`。浏览器配置会保留 Microsoft 的“保持登录”状态，所以之后再登录通常不需要重新输密码。

## 注册到 Claude Code

```bash
claude mcp add minerva --scope user -- node "<本文件夹的绝对路径>/src/server.js"
```

也可以写成 JSON 配置（Claude Desktop 的 `claude_desktop_config.json`，或项目里的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "minerva": { "command": "node", "args": ["<绝对路径>/src/server.js"] }
  }
}
```

## 工具

| 工具 | 用途 |
| --- | --- |
| `minerva_status` | 检查是否已登录，以及会话何时过期 |
| `minerva_whoami` | 当前用户 |
| `minerva_list_courses` | 课程列表，可按代码或名称筛选 |
| `minerva_list_announcements` | 某门课的公告 |
| `minerva_list_contents` | 课程大纲 / 文件夹内容 |
| `minerva_get_content` | 单个内容的全文和附件列表 |
| `minerva_download_attachment` | 下载附件到 `~/Downloads/minerva` |
| `minerva_my_grades` | 成绩册：截止日期、提交状态、分数、反馈 |
| `minerva_upcoming_deadlines` | 扫描所有当前课程，列出 N 天内的截止项 |
| `minerva_calendar` | 日历事件 |
| `minerva_api_get` | 直接 GET 任意 `/learn/api/public/` 接口 |
| `gradescope_status` | 检查 Gradescope 是否已登录 |
| `gradescope_list_courses` | Gradescope 课程列表（按学期，最新在前） |
| `gradescope_list_assignments` | 某门课的作业：提交状态、分数、发布 / 截止 / 迟交截止时间 |
| `gradescope_get_submission` | 一次提交的详情：总分、每题得分、rubric、评语、autograder 结果 |
| `gradescope_upcoming` | 本学期 N 天内要交的 Gradescope 作业 |

## 环境变量

- `MINERVA_BROWSER`：登录用的浏览器通道（`msedge` / `chrome`），默认先试 Edge
- `MINERVA_MCP_HOME`：会话目录，默认 `~/.minerva-mcp`
- `MINERVA_DOWNLOAD_DIR`：下载目录，默认 `~/Downloads/minerva`

## 已知限制

- 2026-10-16 用学生账号测过：课程、公告、大纲、附件下载、成绩册、截止日期、日历都能用。成绩册只列出已经评分的项目，没评分的项目 `graded` 为 `false`。
- Gradescope 作业在 Minerva 里只有截止日期，提交状态和分数请用 `gradescope_*` 工具查。
- Minerva 和 Gradescope 工具的 `courseId` 都可以写短代码（如 `COMP3620`），会自动匹配最新一年的那门课。
- Gradescope 部分是解析网页实现的，Gradescope 改版后可能需要更新解析代码。
- Turnitin、Panopto 等第三方 LTI 工具里的内容拿不到。
- 请合理使用，遵守学校的 IT 使用政策。
