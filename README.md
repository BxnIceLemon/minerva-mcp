# minerva-mcp

**English** | [简体中文](README_zh.md)

An unofficial, read-only MCP server for the University of Leeds' Minerva (Blackboard Learn Ultra) and Gradescope. It follows the approach of [campus-cli](https://github.com/alejooroncoy/campus-cli). You sign in yourself in a real browser window, and the server reuses that session. Minerva data comes from the Blackboard REST API. Gradescope data comes from its web pages, because Gradescope has no API for students.

## Security

- You type your password and MFA code into an Edge or Chrome window yourself. The scripts never see them.
- Sessions are saved in `~/.minerva-mcp/session.json` and `~/.minerva-mcp/gradescope-session.json`. The browser profile is in `~/.minerva-mcp/browser-profile`. None of these are inside the project folder.
- The clients send only GET requests, and only to `minerva.leeds.ac.uk` and `www.gradescope.com`. When a file download redirects to Blackboard's file host, the session cookie is dropped. Nothing is ever submitted on your behalf.
- There is no telemetry.

## Usage

Run these commands inside this folder:

```bash
npm install
npm run login              # opens a browser; sign in to Minerva and the window closes itself
npm run login:gradescope   # sign in to Gradescope (School Credentials → University of Leeds, or open any Gradescope link from Minerva)
npm run check              # prints your name and current courses
```

A Blackboard session usually expires after a few hours. When it does, run `npm run login` again. If Gradescope expires, run `npm run login:gradescope`. The browser profile keeps Microsoft's "Stay signed in" state, so later logins usually don't ask for your password again.

## Add to Claude Code

```bash
claude mcp add minerva --scope user -- node "<absolute path to this folder>/src/server.js"
```

Or add it as JSON config, either in Claude Desktop's `claude_desktop_config.json` or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "minerva": { "command": "node", "args": ["<absolute path>/src/server.js"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `minerva_status` | Check whether you're signed in and when the session expires |
| `minerva_whoami` | Show the signed-in user |
| `minerva_list_courses` | List your courses, optionally filtered by code or name |
| `minerva_list_announcements` | Announcements for a course |
| `minerva_list_contents` | Course outline and folder contents |
| `minerva_get_content` | Full text of one content item, plus its attachments |
| `minerva_download_attachment` | Download an attachment to `~/Downloads/minerva` |
| `minerva_my_grades` | Gradebook: due dates, submission status, scores and feedback |
| `minerva_upcoming_deadlines` | Items due in the next N days across all current courses |
| `minerva_calendar` | Calendar events |
| `minerva_api_get` | GET any `/learn/api/public/` endpoint directly |
| `gradescope_status` | Check whether you're signed in to Gradescope |
| `gradescope_list_courses` | Your Gradescope courses by term, newest first |
| `gradescope_list_assignments` | Assignments in a course: submission status, score, release, due and late-due dates |
| `gradescope_get_submission` | One submission in detail: total score, per-question scores, rubric items, comments and autograder results |
| `gradescope_upcoming` | Gradescope assignments due this term in the next N days |

## Environment variables

- `MINERVA_BROWSER`: the browser channel used for login (`msedge` or `chrome`). Edge is tried first by default.
- `MINERVA_MCP_HOME`: the session folder. Defaults to `~/.minerva-mcp`.
- `MINERVA_DOWNLOAD_DIR`: the download folder. Defaults to `~/Downloads/minerva`.

## Known limitations

- Tested with a student account on 2026-10-16. Courses, announcements, outlines, attachment downloads, gradebook, deadlines and calendar all work. The gradebook only has entries for graded items; items that haven't been graded yet show `graded: false`.
- Minerva only knows the due date of a Gradescope assignment. For its submission status and score, use the `gradescope_*` tools.
- In both the Minerva and Gradescope tools, `courseId` accepts a short module code such as `COMP3620` and matches the most recent course with that code.
- The Gradescope support works by parsing web pages, so a Gradescope redesign may require updating the parser.
- Content inside third-party LTI tools such as Turnitin and Panopto is not available.
- Please use this responsibly and follow the University's IT policies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `main` is protected: changes go through pull requests and must pass CI (`npm test`). To report a security issue, see [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE)
