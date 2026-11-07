// Parsing a saved 金智「我的课表」page (fictional sample shaped like the real one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseJwTimetable, courseTitle, termStartFrom } from '../jw-timetable.js';

const HTML = readFileSync(new URL('./fixtures/jw-timetable.html', import.meta.url), 'utf8');
const parse = source => new JSDOM(source).window.document;

test('every arrangement becomes one course with weeks, parity, clock times and room; teachers are left out', () => {
  const result = parseJwTimetable(HTML, parse);
  assert.deepEqual(result.courses.map(course => course.title), ['高等数学A', '大学英语(3)', '体育(3)', '数字摄影基础']);
  const [math, english, sport, photo] = result.courses;
  assert.deepEqual([math.weekdays, math.start_time, math.end_time, math.weeks, math.parity, math.location], [[1], '08:00', '09:50', [[1, 16]], 'all', '主楼301']);
  assert.deepEqual([english.weeks, english.parity], [[[1, 9]], 'odd']);
  assert.deepEqual([sport.weeks, sport.parity, sport.location], [[[2, 8]], 'even', '无']);
  assert.deepEqual([photo.weeks, photo.location], [[[1, 4], [6, 17]], '实验楼(北),2层机房'], 'week lists and commas inside the room survive');
  assert.equal(result.courses.filter(course => course.title === '数字摄影基础').length, 1, 'a course drawn in several cells is kept once');
  assert.ok(result.courses.every(course => result.text.includes(course.quote)), 'every quote is a line of the transcript');
  assert.doesNotMatch(result.text, /某老师|2100000001/, 'no teacher names or course codes');
  assert.deepEqual(result.skipped, ['看不懂的格子']);
});

test('period times, the current teaching week and the term are read from the page', () => {
  const result = parseJwTimetable(HTML, parse);
  assert.deepEqual(result.periods['1'], { start: '08:00', end: '08:50' });
  assert.equal(Object.keys(result.periods).length, 6);
  assert.equal(result.currentWeek, 9);
  assert.equal(result.term, '2026-2027-1');
});

test('the first Monday is counted back from the week the page was saved in', () => {
  assert.equal(termStartFrom('2026-11-07', 9), '2026-09-07');
  assert.equal(termStartFrom('2026-11-02', 9), '2026-09-07');
  assert.equal(termStartFrom('2026-11-07', null), null);
});

test('titles lose the course code and the class number', () => {
  assert.equal(courseTitle('2131030296 C++基础与AI编程[01]'), 'C++基础与AI编程');
});

test('pages without a timetable grid, or with an empty one, explain what to do', () => {
  assert.throws(() => parseJwTimetable('<p>登录</p>', parse), /没有找到课表格子/);
  assert.throws(() => parseJwTimetable('<table class="wut_table"><tr><td data-role="item"></td></tr></table>', parse), /课表格子是空的/);
});
