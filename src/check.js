#!/usr/bin/env node
// Quick sanity check after `npm run login`: prints who you are and your courses.
import { whoami, listCourses } from './minerva.js';

try {
  const me = await whoami();
  console.log(`Signed in as ${me.name} (${me.userName})`);
  const courses = await listCourses();
  console.log(`${courses.length} current courses:`);
  for (const c of courses) console.log(`  ${c.id}  ${c.code}  ${c.name}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
