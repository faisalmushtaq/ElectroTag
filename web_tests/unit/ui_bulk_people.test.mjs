// The list of "Add several" (js/admin/bulk_people.js; docs/admin_area.md, "Adding several people"): roles,
// a CSV file's columns in any order, quoted cells, and files as spreadsheets save them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as bulk from '../../electrotag/web/static/js/admin/bulk_people.js';

test('a fourth part that is not a role is pointed out', () => {
  const bad = bulk.parseBulkPeople('A15,a,b@c.org,extra');
  assert.match(bad.problems[0].text, /"extra" is not a role/);
});

test('roles, a CSV file\'s columns in any order, and quoted cells', () => {
  // the roles chosen above the list go to everyone without roles of their own
  const out = bulk.parseBulkPeople('Email,ID,Roles,Name\nx@example.org,E05,"expert, annotator","Smith, Alex"\nz@example.org,B06,Administrator,\n,B07,,Kim',
    { roles: ['expert'] });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.rows.map((r) => [r.annotator_id, r.display_name, r.email, r.roles]),
    [['E05', 'Smith, Alex', 'x@example.org', ['expert', 'annotator']], ['B06', '', 'z@example.org', ['admin']], ['B07', 'Kim', null, ['expert']]]);
  assert.deepEqual(out.rows.map(bulk.invited), [true, false, true], 'administrators get a temporary password, never a link');
  // without column names: ID, name, email, roles; a spreadsheet saved with semicolons; a byte-order mark
  const semi = bulk.parseBulkPeople('﻿A20;Ana;ana@example.org;annotator + expert');
  assert.deepEqual(semi.rows[0].roles, ['expert', 'annotator']);
  assert.match(bulk.parseBulkPeople('A21, Bo, bo@example.org, participant').problems[0].text, /participant role cannot be given yet/);
  assert.match(bulk.parseBulkPeople('ID, Name, Phone\nA22, Cy, 0123').problems[0].text, /does not read the column "Phone"/);
  assert.match(bulk.parseBulkPeople('Name, Email\nCy, cy@example.org').problems[0].text, /no column for the annotator ID/);
  assert.match(bulk.parseBulkPeople('ID, ID\nA23, A24').problems[0].text, /names a column twice/);
  assert.deepEqual(bulk.splitLine('"say ""hi""",A1,  b '), ['say "hi"', 'A1', 'b']);
  assert.deepEqual(bulk.rolesOfCell('Admin and Expert').roles, ['admin', 'expert']);
});

test('a file is read whatever a spreadsheet saved it as', async () => {
  const file = (bytes, name = 'people.csv') => ({ name, size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer });
  const utf8 = [...new TextEncoder().encode('﻿A30, Zoë, z@example.org')];
  assert.equal((await bulk.readPeopleFile(file(utf8))).text, 'A30, Zoë, z@example.org');
  const utf16 = [0xff, 0xfe, ...[...'A31, Ann'].flatMap((c) => [c.charCodeAt(0), 0])];
  assert.equal((await bulk.readPeopleFile(file(utf16))).text, 'A31, Ann');
  assert.equal((await bulk.readPeopleFile(file([0x41, 0x33, 0x32, 0x2c, 0x20, 0x5a, 0xeb]))).text, 'A32, Zë', 'an older spreadsheet\'s own encoding');
  assert.match((await bulk.readPeopleFile(file([0x50, 0x4b, 3, 4], 'people.xlsx'))).problem, /save it as CSV/);
  assert.match((await bulk.readPeopleFile({ name: 'big.csv', size: bulk.MAX_FILE_BYTES + 1 })).problem, /larger than a list of people/);
});
