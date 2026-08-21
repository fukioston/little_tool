import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/career/CareerApp.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/career/career.css", import.meta.url), "utf8");

function component(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start) : source.length;
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
  return source.slice(start, end);
}

test("Today and the sidebar never turn a quiet period into a performance score", () => {
  const today = component("TodayView", "BoardView");
  const sidebar = component("Sidebar", "Topbar");
  assert.doesNotMatch(today, /<Metric|career-metric-grid|活跃机会|近期待面|等待回应|待办节奏/);
  assert.match(today, /只保留事实，不把安静的日子解释成落后/);
  assert.match(today, /还没有变化需要回看/);
  assert.doesNotMatch(sidebar, /data\.jobs|data\.activities|近 7 天|次变化|个机会/);
  assert.match(sidebar, /这里不评价进度/);
  assert.match(sidebar, /等待、暂停或暂时没有新变化，都是正常状态/);
});

test("the former analytics surface is a factual reflection without ranks or conversion", () => {
  const reflection = component("AnalyticsView", "SettingsView");
  assert.match(reflection, /过程回顾/);
  assert.match(reflection, /最近发生的事/);
  assert.match(reflection, /接下来已明确安排/);
  assert.match(reflection, /最近想保留的面经/);
  assert.match(reflection, /没有结果评分/);
  assert.match(reflection, /不排名，也不计算转化/);
  assert.doesNotMatch(reflection, /career-metric|career-bars|career-funnel|career-source-performance|缺下一步/);
  assert.doesNotMatch(reflection, /\.length\}\s*(个|项|次)|Math\.round|百分比|转化率|offer率/i);
});

test("job attention is a boolean personal marker rather than a three-step rank", () => {
  assert.match(source, /careerJobIsWatched\(job\.priority\)/);
  assert.match(source, /只看已关注/);
  assert.match(source, /是否关注/);
  assert.match(source, /只是方便筛选，不是优先级评分/);
  assert.match(source, /<option value="1">普通记录<\/option><option value="2">已关注<\/option>/);
  assert.doesNotMatch(source, /priority\s*>=\s*3|aria-label=\{`优先级|career-priority/);
});

test("job cards use only a real future fact and never paint old dates as debt", () => {
  const label = component("careerJobNextLabel", "JobCard");
  const card = component("JobCard", "JobsView");
  const jobs = component("JobsView", "CalendarView");
  assert.match(card, /resolveCareerJobNextItem\(job\.id, data\.tasks, data\.interviews, now\)/);
  assert.match(card, /还没有明确安排下一步/);
  assert.match(label, /时间未定/);
  assert.doesNotMatch(card, /nextTask|className=\{`career-next.*late|relativeDate\(/);
  assert.match(jobs, /resolveCareerJobNextItem\(job\.id, data\.tasks, data\.interviews, now\)/);
  assert.match(jobs, /careerJobNextLabel\(next, now\)/);
  assert.doesNotMatch(jobs, /const task = data\.tasks\.find|career-mobile-job-next.*late|career-late-text|relativeDate\(/);
});

test("the calm reflection layout remains one-column and readable on a phone", () => {
  assert.match(css, /\.career-reflection-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s+minmax\(300px,\s*\.85fr\)/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-reflection-notes > div\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.career-calm-empty\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.career-sidebar\.open \.career-sidebar-calm\s*\{\s*display:\s*flex/);
});
