// Gradescope has no public student API, so this works from the same pages and
// JSON the website uses. Reads live in gradescope/read.js; the two actions that
// change anything (upload, regrade request) live in gradescope/write.js.
export * from './gradescope/read.js';
export { submit, requestRegrade } from './gradescope/write.js';
