# minerva-mcp

**English** | [简体中文](README_zh.md)

An unofficial MCP server and command-line tool for the University of Leeds' Minerva (Blackboard Learn Ultra) and Gradescope. It follows the approach of [campus-cli](https://github.com/alejooroncoy/campus-cli). You sign in yourself in a real browser window, and the tools reuse that session. Minerva data comes from the Blackboard REST API. Gradescope data comes from the same pages and JSON its website uses, because Gradescope has no API for students.

On Minerva you can also submit files or text to Ultra assignments. On Gradescope you can also upload and resubmit, make an earlier submission the active one, add or remove group members, and send or edit regrade requests. These are the only actions that change anything.

## Security

- Sign-in happens in your system default browser (Edge, Chrome, Brave and other Chromium browsers). You type your password and MFA code there yourself; the code never sees them.
- The optional terminal sign-in (`--terminal`) is the one exception: you type your password in the terminal and it is filled straight into Microsoft's own form in a hidden window. It is never saved, logged or sent anywhere else, and the MCP tools never accept a password.
- The browser runs with a dedicated profile for each saved account (`~/.minerva-mcp/accounts/<account>/browser-profile`), separate from your everyday profile. The tools never read your normal browser's cookies or saved passwords.
- Sessions are saved per account in `~/.minerva-mcp/accounts/<account>/` (`session.json` and `gradescope-session.json`), so several people's sign-ins never mix. None of these are inside the project folder.
- Requests only go to `minerva.leeds.ac.uk` and `www.gradescope.com`. When a file download redirects to Blackboard's file host, the session cookie is dropped. The one exception is the update check: a single request to `api.github.com` per start, with no cookies or account data (see [Updates](#updates)).
- Minerva: only GET requests, except assignment submissions (`minerva submit`). Gradescope: only GET requests, except `submit`, `activate`, `add-member`, `remove-member` and `regrade`:
  - In the CLI, each one shows what it will do and ask `[y/N]` before sending. `--dry-run` only shows the plan.
  - In MCP, every write tool call needs `confirm: true`, and the agent is told to show you a dry run and get your yes first. Without `confirm: true` nothing is sent.
- There is no telemetry.

## Usage

Run these commands inside this folder:

```bash
npm install
npm run login              # opens a browser; sign in to Minerva and the window closes itself
npm run login:gradescope   # sign in to Gradescope (School Credentials → University of Leeds, or open any Gradescope link from Minerva)
npm run check              # prints your name and current courses
```

Both logins open your default browser. Gradescope goes straight to the University of Leeds sign-in, the same Microsoft account as Minerva.

Sessions expire after a few hours, but you rarely need to sign in again:

- **Silent refresh.** Every login first tries a hidden window. If Microsoft still remembers you ("Stay signed in"), the session is renewed in a few seconds with no window.
- **CLI.** When a `minerva` or `gradescope` command finds its session expired, it refreshes silently and retries. If you have to sign in, it asks whether to open the sign-in page.
- **Terminal sign-in.** On a server or over SSH, sign in without a window: see below.
- **Agent.** The MCP server has `minerva_login` and `gradescope_login` tools. When a tool reports an expired session, the agent (any MCP client) can call them itself. If you need to act, the University sign-in page opens in your default browser and the agent asks you to finish signing in.

### Several accounts

Each account is saved apart from the others: its Minerva session, its Gradescope session and its own browser profile live in `~/.minerva-mcp/accounts/<Minerva username>/`. Signing in one person never touches another's sign-in.

```bash
npm run login                              # first account (named after your Minerva username)
npm run login -- --new-account             # sign in someone else and save them as another account
minerva accounts                           # list saved accounts
minerva upcoming --account ab12cd          # use one account for a command (or set MINERVA_ACCOUNT)
```

- With one saved account, everything uses it.
- With several and none chosen, a command in a terminal asks which one to use; without a terminal it stops and asks for `--account`.
- In MCP, the server asks you through your client's prompt (if the client supports MCP elicitation) and keeps your answer for the session. Otherwise the agent is told to ask you, then passes `account`. `minerva_list_accounts` and `minerva_select_account` list and switch accounts.
- A sign-in for an existing account that turns out to be a different person is refused, so one account's folder never holds someone else's session.
- Sessions saved before accounts existed are moved into `accounts/<username>/` the first time a new version runs.

### Signing in from a terminal

```bash
npm run login -- --terminal                 # Minerva
gradescope login --terminal                 # Gradescope
npm run login -- --terminal --mfa passcode  # type a Duo passcode instead of approving a push
```

The browser runs hidden. You're asked for your University username (`ab12cd` becomes `ab12cd@leeds.ac.uk`) and password, then Duo sends a push to your phone; if Duo shows a number, the terminal tells you which one to enter in Duo Mobile. `--mfa` chooses `push` (default), `passcode` (Duo Mobile or hardware token), `sms` or `call`. If a push times out you can retry or switch to a passcode. It answers "Stay signed in" and Duo's "Is this your device?" with yes, so later logins usually refresh silently.

Terminal sign-in is used automatically on Linux when there is no display. Without Edge or Chrome installed, run `npx playwright-core install chromium` once in this folder.

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
gradescope activate COMP3620 Perceptron 123456789 # make an earlier submission the active one
gradescope members COMP2850 "Team Project"         # who is in your group submission
gradescope add-member COMP2850 "Team Project" "Ada Lovelace"   # add a classmate (name, email or id)
gradescope remove-member COMP2850 "Team Project" me             # leave the group (or name someone)
gradescope regrade COMP3620 "Lab 2" 1.3 -m "My answer matches part (b) of the spec"
```

- `<course>` can be a course number or a module code such as `COMP3620`.
- `<assignment>` can be an assignment id or a unique part of its title.
- Add `--json` to any command for raw JSON. Run `gradescope --help` for everything else.

`submit` supports the three ways Gradescope takes uploads:

- **Code assignments**: any number of files. A `.zip` is unpacked first and its files are uploaded one by one with their paths, exactly like the website's uploader (`__MACOSX/` and `.DS_Store` are skipped). Add `--keep-zip` if an assignment really wants the archive itself.
- **PDF assignments**: exactly one PDF. For variable-length PDFs, you still need to assign pages to questions in the browser afterwards. The command prints the link.
- **Document assignments**: exactly one file.

Online assignments (quizzes) can only be answered in the browser.

## Minerva CLI

`npm link` also makes the `minerva` command available. Or run `node src/minerva-cli.js`.

```bash
minerva login                                     # sign in (same as npm run login)
minerva upcoming --days 14                        # gradebook items due soon, across your courses
minerva submissions COMP3620 CW2                  # an assignment's settings and your attempts on it
minerva submit COMP3620 CW2 report.pdf code.zip --dry-run   # show what would be sent
minerva submit COMP3620 CW2 report.pdf code.zip   # submit as a new attempt (asks first)
minerva submit COMP3620 CW2 -m "Link: https://…"  # text only
```

- `submit` works on Ultra assignments without questions (the ones where you add files or text and press Submit). Each run is a new attempt, so check how many attempts the assignment allows: `submissions` shows it.
- Files are uploaded as they are; archives are not unpacked.
- Assignments with questions, group assignments, and ones that need a password or a secure browser are refused; use the browser for those. So are items that link to Gradescope or another tool.
- After submitting, the command checks that Minerva's receipt lists the uploaded files.

## Updates

Each time the MCP server starts, it checks once whether GitHub's `main` branch has a newer version than the copy it runs from. If it does, the first tool answer tells the agent which changes are new. The agent then explains them and asks whether you want to update. It only updates after your yes: `minerva_update` shows a dry run, then fetches `main`, switches to it and runs `npm install`. A branch you were on is kept, and a local `main` with commits that aren't on GitHub is kept as a backup branch first. Restart your MCP client afterwards.

- The check is one request to `api.github.com` with the commit id this copy runs. No cookies or account data are sent.
- It needs a git checkout (`git clone`). Copies without git can't tell their version, so they are never flagged.
- Set `MINERVA_NO_UPDATE_CHECK=1` to turn the check off. You can still ask the agent to check (`minerva_check_update`).

## Add to an MCP client

Most MCP clients accept a stdio server in this JSON form (in the client's MCP settings file, or a project's `.mcp.json`):

```json
{
  "mcpServers": {
    "minerva": {
      "command": "node",
      "args": ["<absolute path to this folder>/src/server.js"]
    }
  }
}
```

Restart the client afterwards. The write tools (`minerva_submit` and the `gradescope_*` ones that change something) are available straight away; each still needs a dry run and `confirm: true`.

## Add to Codex

```bash
codex mcp add minerva -- node "<absolute path to this folder>/src/server.js"
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.minerva]
command = "node"
args = ["<absolute path>/src/server.js"]
tool_timeout_sec = 300   # waiting for a sign-in or an autograder can take longer than Codex's 60 s default
```

Restart Codex afterwards. The tools work the same in Codex. With the default 60 s timeout they still work, but `minerva_login` / `gradescope_login` return `waitingForUser` sooner, and `gradescope_get_results` should be called with `waitSeconds` under 60.

## MCP tools

| Tool | What it does |
| --- | --- |
| `minerva_list_accounts` | List saved accounts and which one this session uses |
| `minerva_select_account` | Choose the account for the rest of the session (after asking the user) |
| `minerva_check_update` | Check GitHub for a newer version and list what it adds |
| `minerva_update` | Update this copy to the latest version (needs `confirm: true`) |
| `minerva_status` | Check whether you're signed in and when the session expires (lists every account when none is chosen) |
| `minerva_login` | Refresh or start a Minerva sign-in; opens your default browser if you need to act |
| `minerva_whoami` | Show the signed-in user |
| `minerva_list_courses` | List your courses, optionally filtered by code or name |
| `minerva_list_announcements` | Announcements for a course |
| `minerva_list_contents` | Course outline and folder contents |
| `minerva_get_content` | Full text of one content item, plus its attachments and files embedded in the page |
| `minerva_download_attachment` | Download an attachment or embedded file to `~/Downloads/minerva` |
| `minerva_my_grades` | Gradebook: due dates, submission status, scores and feedback |
| `minerva_upcoming_deadlines` | Items due in the next N days across all current courses |
| `minerva_calendar` | Calendar events |
| `minerva_list_submissions` | An assignment's submission settings and your attempts, with receipts and files |
| `minerva_api_get` | GET any `/learn/api/public/` endpoint directly |
| `minerva_submit` | Submit files or text to an Ultra assignment (needs `confirm: true`) |
| `gradescope_status` | Check whether you're signed in to Gradescope |
| `gradescope_login` | Refresh or start a Gradescope sign-in through Leeds SSO; opens your default browser if needed |
| `gradescope_list_courses` | Your Gradescope courses by term, newest first |
| `gradescope_list_assignments` | Assignments in a course: submission status, score, release, due and late-due dates |
| `gradescope_upcoming` | Gradescope assignments due this term in the next N days |
| `gradescope_grades` | Scores for every assignment in a course, with the total |
| `gradescope_get_submission` | One submission in full: scores, rubric, comments, annotations, regrade threads, autograder |
| `gradescope_get_results` | Autograder test results; `waitSeconds` polls while it runs |
| `gradescope_get_comments` | Grader feedback and regrade requests with staff replies |
| `gradescope_list_submissions` | Every submission to an assignment, marking the active one and which can be activated |
| `gradescope_list_group_members` | Who is in your group submission, the size limit, and whether it can still change |
| `gradescope_submit` | Upload or resubmit (needs `confirm: true`) |
| `gradescope_activate_submission` | Make an earlier submission the active one (needs `confirm: true`) |
| `gradescope_add_group_members` | Add classmates to your group submission (needs `confirm: true`) |
| `gradescope_remove_group_member` | Remove a group member, or leave the group (needs `confirm: true`) |
| `gradescope_request_regrade` | Send or update a regrade request (needs `confirm: true`) |

## Environment variables

- `MINERVA_BROWSER`: the browser for sign-in, as a path to its executable or a channel (`msedge`, `chrome`). Defaults to your system default browser. If that is Firefox or Safari, which can't be automated, an installed Edge or Chrome is used instead.
- `MINERVA_MCP_HOME`: the session folder. Defaults to `~/.minerva-mcp`.
- `MINERVA_DOWNLOAD_DIR`: the download folder. Defaults to `~/Downloads/minerva`.
- `GRADESCOPE_SSO_PATH`: Gradescope's school sign-in path. Defaults to the University of Leeds; set it to an empty value to use the plain Gradescope login page.
- `MINERVA_ACCOUNT`: the saved account to use, instead of being asked. Same as `--account`.
- `MINERVA_NO_UPDATE_CHECK`: set to `1` to stop the MCP server from checking GitHub for a newer version when it starts.
- `MINERVA_NO_AUTO_LOGIN`: set to `1` to stop the CLI from refreshing an expired session by itself.
- `MINERVA_USERNAME`: the username terminal sign-in fills in, instead of asking. Same as `--user`.
- `MINERVA_MFA`: the default `--mfa` method for terminal sign-in.

## Known limitations

- Tested with a student account on 2026-10-16 and 2026-10-21. Courses, announcements, outlines, attachment downloads, gradebook, deadlines and calendar all work. The gradebook only has entries for graded items; items that haven't been graded yet show `graded: false`.
- Gradescope reads were tested on real code, PDF, online and group assignments. All write actions were only tested as dry runs, including their refusals (closed assignments, full or locked groups). The request formats come from Gradescope's own web code, but none has been sent for real yet.
- Gradescope doesn't let students delete a submission. To "undo" one, resubmit or activate an earlier submission instead.
- No sample with teacher annotations was available, so annotation text is extracted on a best-effort basis.
- Minerva submission was tested for real on 2026-11-04 with a file upload to an Ultra assignment, and the file read back from Minerva matched the original. Blackboard's public API can't attach files in Ultra courses, so it follows the requests the Ultra web page sends; a Minerva update may require changing it. Text-only submissions follow the same requests but have not been sent for real.
- Minerva only knows the due date of a Gradescope assignment. For its submission status and score, use the `gradescope_*` tools.
- In both the Minerva and Gradescope tools, `courseId` accepts a short module code such as `COMP3620` and matches the most recent course with that code.
- The Gradescope support follows the website's internals, so a Gradescope redesign may require updating it.
- Content inside third-party LTI tools such as Turnitin and Panopto is not available.
- Please use this responsibly and follow the University's IT and academic integrity policies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `main` is protected: changes go through pull requests and must pass CI (`npm test`). To report a security issue, see [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE)
