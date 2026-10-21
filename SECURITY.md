# Security Policy

This project handles University login sessions, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/BxnIceLemon/minerva-mcp/security/advisories/new)
with:

- what the problem is and what an attacker could do with it
- steps to reproduce
- the version or commit you tested

You should get a reply within 7 days.

## What counts

- A way for session cookies to leave `minerva.leeds.ac.uk` or `www.gradescope.com`
- A way to send a non-GET request other than the Gradescope `submit` and `regrade` actions
- A way for `submit` or `regrade` to send without confirmation: skipping the CLI prompt, or the MCP tools working without `GRADESCOPE_ALLOW_WRITE=1` or without `confirm: true`
- A way for an upload to include files the user didn't name
- Session files or the browser profile being readable by other users, or being written into the project folder
- Path traversal in attachment downloads

## Please never share

Do not include your session files (`~/.minerva-mcp/*.json`), cookies, passwords or student ID in a report.
