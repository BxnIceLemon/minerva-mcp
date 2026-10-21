## What changed

<!-- One or two sentences on what this PR does and why. -->

## How it was tested

- [ ] `npm test` passes
- [ ] Tried against a real Minerva / Gradescope account (say which tools)

## Checklist

- [ ] No new non-GET requests outside `src/gradescope/write.js`
- [ ] Any write is dry-runnable, confirmed in the CLI, and opt-in plus `confirm: true` in MCP
- [ ] Writes were tested only as dry runs, not on real coursework
- [ ] Session cookies still only go to `minerva.leeds.ac.uk` / `www.gradescope.com`
- [ ] No personal data (cookies, session files, saved pages, real names or IDs) in the diff
