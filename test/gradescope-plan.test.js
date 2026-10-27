// Validation for activating submissions and changing group members.
// Everyone here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeGroup, matchMembers, planAddMembers, planRemoveMember, planActivate, shapeHistory } from '../src/gradescope/parse.js';

const ROSTER = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.ac.uk' },
  { id: 2, name: 'Alan Turing', email: 'alan@example.ac.uk' },
  { id: 3, name: 'Grace Hopper', email: 'grace@example.ac.uk' },
  { id: 4, name: 'Alan Kay', email: 'kay@example.ac.uk' },
];

const PROPS = {
  assignment: { title: 'Group Lab', group_size: 3, group_members_updatable: true },
  current_user: { id: 1 },
  course_members: ROSTER,
  ownerships: [
    { id: 501, user_id: 1, active: true, uploader: true },
    { id: 502, user_id: 3, active: true, uploader: false },
  ],
};

test('shapeGroup names members and marks you', () => {
  const g = shapeGroup(PROPS);
  assert.equal(g.groupSize, 3);
  assert.equal(g.canUpdate, true);
  assert.deepEqual(
    g.members.map((m) => [m.name, m.ownershipId, m.you, m.uploader]),
    [
      ['Ada Lovelace', 501, true, true],
      ['Grace Hopper', 502, false, false],
    ],
  );
});

test('matchMembers finds people by id, email, full or partial name', () => {
  assert.equal(matchMembers(ROSTER, ['2'])[0].name, 'Alan Turing');
  assert.equal(matchMembers(ROSTER, ['KAY@example.ac.uk'])[0].name, 'Alan Kay');
  assert.equal(matchMembers(ROSTER, ['grace hopper'])[0].id, 3);
  assert.equal(matchMembers(ROSTER, ['turing'])[0].id, 2);
  assert.throws(() => matchMembers(ROSTER, ['alan']), /matches 2 people/);
  assert.throws(() => matchMembers(ROSTER, ['nobody']), /Nobody/);
});

test('planAddMembers skips current members and enforces the size limit', () => {
  const g = shapeGroup(PROPS);
  assert.deepEqual(planAddMembers(g, ROSTER, ['turing', 'ada@example.ac.uk']), [{ userId: 2, name: 'Alan Turing' }]);
  assert.throws(() => planAddMembers(g, ROSTER, ['Ada Lovelace']), /already in the group/);
  assert.throws(() => planAddMembers(g, ROSTER, ['turing', 'kay']), /limited to 3/);
  assert.throws(() => planAddMembers({ ...g, canUpdate: false }, ROSTER, ['turing']), /can't be changed/);
});

test('planRemoveMember finds the member, and "me" means leaving', () => {
  const g = shapeGroup(PROPS);
  assert.equal(planRemoveMember(g, 'grace').ownershipId, 502);
  const me = planRemoveMember(g, 'me');
  assert.equal(me.you, true);
  assert.throws(() => planRemoveMember(g, 'turing'), /not in this group/);
  const solo = { ...g, members: g.members.slice(0, 1) };
  assert.throws(() => planRemoveMember(solo, 'me'), /at least one member/);
});

test('planActivate allows only inactive, activatable submissions', () => {
  const history = shapeHistory({
    past_submissions: [
      { id: 10, created_at: '2026-10-01T10:00:00Z', active: false, can_activate: true, activate_path: '/x/10/activate' },
      { id: 11, created_at: '2026-10-02T10:00:00Z', active: true, can_activate: false },
      { id: 12, created_at: '2026-10-03T10:00:00Z', active: false, can_activate: false },
    ],
  });
  assert.equal(planActivate(history, '10').activatePath, '/x/10/activate');
  assert.throws(() => planActivate(history, '11'), /already the active one/);
  assert.throws(() => planActivate(history, '12'), /doesn't allow/);
  assert.throws(() => planActivate(history, '99'), /not one of yours/);
});
