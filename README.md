# minerva-mcp

**English** | [简体中文](README_zh.md)

An unofficial MCP server and command-line tool for the University of Leeds' Minerva (Blackboard Learn Ultra) and Gradescope. It follows the approach of [campus-cli](https://github.com/alejooroncoy/campus-cli). You sign in yourself in a real browser window, and the tools reuse that session. Minerva data comes from the Blackboard REST API. Gradescope data comes from the same pages and JSON its website uses, because Gradescope has no API for students.

Minerva access is read-only. For Gradescope you can also upload submissions and send regrade requests. These are the only two actions that change anything.

## Security

- You type your password and MFA code into an Edge or Chrome window yourself. The scripts never see them.
- Sessions are saved in `~/.minerva-mcp/session.json` and `~/.minerva-mcp/gradescope-session.json`. The browser profile is in `~/.minerva-mcp/browser-profile`. None of these are inside the project folder.
- Requests only go to `minerva.leeds.ac.uk` and `www.gradescope.com`. When a file download redirects to Blackboard's file host, the session cookie is dropped.
- Minerva: only GET requests. Gradescope: only GET requests, except `submit` and `regrade`:
  - In the CLI, both show what they will do and ask `[y/N]` before sending. `--dry-run` only shows the plan.
  - In MCP, the write tools don't exist unless you set `GRADESCOPE_ALLOW_WRITE=1`. Even then, every call needs `confirm: true`, and Claude is told to show you a dry run and get your yes first.
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

## Gradescope CLI

To make the `gradescope` command available everywhere, run `npm link` once in this folder. Or run `node src/cli.js` directly.

```bash
gradescope login                                  # sign in (same as npm run login:gradescope)
gradescope upcoming --days 14                     # what's due this term
gradescope assignments COMP3620                   # status, score and due date of each assignment
gradescope grades COMP3620                        # scores and course total
gradescope submit COMP3620 Perceptron perceptron.py --wait   # upload, then wait for the autograder
gradescope results COMP3620 Perceptron            # autograder tests with output
gradescope comments COMP3620 Perceptron           # rubric items, comments, regrade threads
gradescope history COMP3620 Perceptron            # every submission you've made
gradescope regrade COMP3620 "Lab 2" 1.3 -m "My answer matches part (b) of the spec"
```

- `<course>` can be a course number or a module code such as `COMP3620`.
- `<assignment>` can be an assignment id or a unique part of its title.
- Add `--json` to any command for raw JSON. Run `gradescope --help` for everything else.

`submit` supports the three ways Gradescope takes uploads:

- **Code assignments**: any number of files. Zip a folder first; Gradescope unzips it.
- **PDF assignments**: exactly one PDF. For variable-length PDFs, you still need to assign pages to questions in the browser afterwards. The command prints the link.
- **Document assignments**: exactly one file.

Online assignments (quizzes) can only be answered in the browser.

## Add to Claude Code

```bash
claude mcp add minerva --scope user -- node "<absolute path to this folder>/src/server.js"
```

To also give Claude the Gradescope write tools, add `-e GRADESCOPE_ALLOW_WRITE=1` before `--`.

Or add it as JSON config, either in Claude Desktop's `claude_desktop_config.json` or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "minerva": { "command": "node", "args": ["<absolute path>/src/server.js"] }
  }
}
```

## MCP tools

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
| `gradescope_upcoming` | Gradescope assignments due this term in the next N days |
| `gradescope_grades` | Scores for every assignment in a course, with the total |
| `gradescope_get_submission` | One submission in full: scores, rubric, comments, annotations, regrade threads, autograder |
| `gradescope_get_results` | Autograder test results; `waitSeconds` polls while it runs |
| `gradescope_get_comments` | Grader feedback and regrade requests with staff replies |
| `gradescope_list_submissions` | Every submission to an assignment, marking the active one |
| `gradescope_submit` | Upload a submission (only with `GRADESCOPE_ALLOW_WRITE=1`) |
| `gradescope_request_regrade` | Send or update a regrade request (only with `GRADESCOPE_ALLOW_WRITE=1`) |

## Environment variables

- `MINERVA_BROWSER`: the browser channel used for login (`msedge` or `chrome`). Edge is tried first by default.
- `MINERVA_MCP_HOME`: the session folder. Defaults to `~/.minerva-mcp`.
- `MINERVA_DOWNLOAD_DIR`: the download folder. Defaults to `~/Downloads/minerva`.
- `GRADESCOPE_ALLOW_WRITE`: set to `1` to register the MCP write tools. The CLI doesn't need it.

## Known limitations

- Tested with a student account on 2026-10-16 and 2026-10-21. Courses, announcements, outlines, attachment downloads, gradebook, deadlines and calendar all work. The gradebook only has entries for graded items; items that haven't been graded yet show `graded: false`.
- Gradescope reads were tested on real code, PDF and online assignments. `submit` and `regrade` were only tested as dry runs. The request format comes from Gradescope's own web code, but the first real upload and the first real regrade request haven't been verified yet.
- No sample with teacher annotations was available, so annotation text is extracted on a best-effort basis.
- Minerva only knows the due date of a Gradescope assignment. For its submission status and score, use the `gradescope_*` tools.
- In both the Minerva and Gradescope tools, `courseId` accepts a short module code such as `COMP3620` and matches the most recent course with that code.
- The Gradescope support follows the website's internals, so a Gradescope redesign may require updating it.
- Content inside third-party LTI tools such as Turnitin and Panopto is not available.
- Please use this responsibly and follow the University's IT and academic integrity policies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `main` is protected: changes go through pull requests and must pass CI (`npm test`). To report a security issue, see [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE)
