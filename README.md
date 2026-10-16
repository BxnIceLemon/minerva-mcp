# minerva-mcp

非官方的利兹大学 Minerva（Blackboard Learn Ultra）MCP 服务器，只读。思路参考 [campus-cli](https://github.com/alejooroncoy/campus-cli)：你在真实浏览器里自己登录，脚本保存 Minerva 的会话 cookie，MCP 服务器拿它调用 Blackboard 的 REST API。

## 安全性

- 密码和 MFA 都由你在 Edge/Chrome 窗口里输入，脚本接触不到。
- 会话保存在 `~/.minerva-mcp/session.json`，浏览器配置在 `~/.minerva-mcp/browser-profile`，都不在项目目录里。
- 客户端只发 GET 请求，只发往 `minerva.leeds.ac.uk`；文件下载跳转到 Blackboard CDN 时会去掉 cookie。
- 没有任何遥测。

## 使用

以下命令都要在本文件夹里运行（先 `cd` 进来）：

```bash
npm install
npm run login     # 弹出浏览器，登录 Minerva，成功后窗口自动关闭
npm run check     # 打印你的名字和当前课程列表
```

Blackboard 会话一般几个小时后过期，过期后重新运行 `npm run login` 就行。浏览器配置会保留 Microsoft 的“保持登录”状态，所以之后再登录通常不需要重新输密码。

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

## 环境变量

- `MINERVA_BROWSER`：登录用的浏览器通道（`msedge` / `chrome`），默认先试 Edge
- `MINERVA_MCP_HOME`：会话目录，默认 `~/.minerva-mcp`
- `MINERVA_DOWNLOAD_DIR`：下载目录，默认 `~/Downloads/minerva`

## 已知限制

- 2026-10-16 用学生账号测过：课程、公告、大纲、附件下载、成绩册、截止日期、日历都能用。成绩册只列出已经评分的项目，没评分的项目 `graded` 为 `false`。
- Gradescope 之类的外部作业，在 Minerva 里只有截止日期，看不到提交状态。
- `courseId` 可以写短代码（如 `COMP3620`），会自动匹配最新一年的那门课。
- Turnitin、Panopto 等第三方 LTI 工具里的内容拿不到。
- 请合理使用，遵守学校的 IT 使用政策。
