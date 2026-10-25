# Notes for coding agents

This repo is an MCP server and CLI for the University of Leeds' Minerva (Blackboard Learn) and Gradescope. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything; the rules below are the ones that matter most.

## Layout

- `src/server.js`: MCP server and tool definitions
- `src/cli.js`: `gradescope` command
- `src/client.js`, `src/minerva.js`: Minerva REST client and features (GET only)
- `src/gradescope/`: `http` (requests and cookies), `parse` (pure parsers), `read`, `write` (the only code that changes data on Gradescope)
- `src/browser.js`, `src/auth.js`, `src/login-manager.js`: default-browser sign-in, silent refresh, and the agent login tools
- `test/`: offline tests (`npm test`), no account needed

## Rules

- Run `npm test` before finishing. CI runs it on Node 20, 22 and 24, and `main` only accepts PRs that pass.
- Session cookies only ever go to `minerva.leeds.ac.uk` and `www.gradescope.com`.
- Non-GET requests belong only in `src/gradescope/write.js`. Every write action:
  - supports a dry run
  - asks for confirmation in the CLI
  - in MCP, is registered only with `GRADESCOPE_ALLOW_WRITE=1` and requires `confirm: true`
- Never upload to, or file regrade requests on, real coursework to test. Use dry runs.
- Never commit personal data: session files, cookies, saved pages, real names, student IDs or real course/submission IDs. Write test fixtures by hand.
- Never read the user's everyday browser profile or its credential stores. Sign-in uses the dedicated profile in `~/.minerva-mcp`.
- Plain ES modules, no build step. Match the style of nearby code.
