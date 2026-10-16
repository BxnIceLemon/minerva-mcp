# Contributing

Thanks for helping. A few rules keep this project safe for everyone who signs in with it.

## Workflow

1. Create a branch from `main`.
2. Make your change and run `npm test`.
3. Open a pull request. CI must pass before it can be merged. PRs are squash-merged.

`main` is protected: nobody pushes to it directly, maintainers included.

## Ground rules

- **Read-only.** Clients only send GET requests. Changes that submit, post or modify anything on Minerva or Gradescope will not be accepted.
- **Stay on the two hosts.** Session cookies must only ever go to `minerva.leeds.ac.uk` and `www.gradescope.com`.
- **No personal data in the repo.** Never commit session files, cookies, saved HTML pages, screenshots or tool output from your account. Build test fixtures by hand with fake names and IDs.
- **Match the existing style.** Plain ES modules, no build step, small focused files.

## Testing against a real account

`npm test` runs offline. To check your change against the real sites, run `npm run login`, `npm run login:gradescope` and `npm run check`, then try the tools from an MCP client. Describe what you tested in the PR, without pasting personal data.
