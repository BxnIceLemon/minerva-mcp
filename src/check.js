#!/usr/bin/env node
// Quick sanity check after `npm run login`: prints who you are and your courses.
import { parseArgs } from 'node:util';
import { whoami, listCourses } from './minerva.js';
import { selectAccount } from './accounts.js';
import { chooseAccountCli } from './login-cli.js';

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { account: { type: 'string' } } });
  const { account } = await chooseAccountCli(values);
  if (account) selectAccount(account);
  const me = await whoami();
  console.log(`Signed in as ${me.name} (${me.userName})${account ? `, account ${account}` : ''}`);
  const courses = await listCourses();
  console.log(`${courses.length} current courses:`);
  for (const c of courses) console.log(`  ${c.id}  ${c.code}  ${c.name}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
