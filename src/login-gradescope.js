#!/usr/bin/env node
// Signs in to Gradescope: `node src/login-gradescope.js` (or `npm run
// login:gradescope`). Tries a silent refresh first, then opens your default
// browser: use "School Credentials" with your Leeds account, an email and
// password, or open any Gradescope link from Minerva.
import { runLoginCli } from './login-cli.js';

process.exitCode = await runLoginCli('gradescope');
