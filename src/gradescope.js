// Gradescope has no public student API, so this works from the same pages and
// JSON the website uses. Reads live in gradescope/read.js; every action that
// changes anything lives in gradescope/write.js.
export * from './gradescope/read.js';
export {
  submit,
  requestRegrade,
  activateSubmission,
  addGroupMembers,
  removeGroupMember,
} from './gradescope/write.js';
