import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/career/CareerApp.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/career/career.css", import.meta.url), "utf8");

const start = source.indexOf("function AnalyticsView");
const end = source.indexOf("function SettingsView", start);
assert.notEqual(start, -1, "AnalyticsView must exist");
assert.notEqual(end, -1, "SettingsView must follow AnalyticsView");
const analytics = source.slice(start, end);

test("reflection opens with qualitative context instead of a scorecard", () => {
  assert.match(analytics, /过程回顾/);
  assert.match(analytics, /职位现在放在哪里/);
  assert.match(analytics, /阶段和来源只帮你找回上下文，不代表做得好或不好/);
  assert.match(analytics, /不把 Offer 或阶段当成你的分数/);
  assert.doesNotMatch(analytics, /<Metric|career-metric|career-bars|career-funnel|career-source-performance/);
  assert.doesNotMatch(analytics, /完成率|转化率|offer率|风险分|进度分|排名第|欠下一步/i);
});

test("stage and source remain factual across active, terminal, and archived records", () => {
  assert.match(analytics, /job\.archived !== 1 && !terminalStageIds\.has\(job\.stage_id\)/);
  assert.match(analytics, /job\.archived === 1 \|\| terminalStageIds\.has\(job\.stage_id\)/);
  assert.match(analytics, /阶段 · \{stage\?\.name \|\| "待确认"\}/);
  assert.match(analytics, /来源 · \{job\.source\.trim\(\) \|\| "未记录"\}/);
  assert.match(analytics, /已归档 · 只是收好记录/);
  assert.match(analytics, /已结束 · 只记录结果/);
  assert.match(analytics, /结束或收起只是记录状态，不是对你的结论/);
  assert.match(analytics, /遇到想记住的机会时再添加，不需要先填满这里/);
  assert.match(source, /view === "analytics" && <AnalyticsView data=\{allData\}/);
});

test("only real future plans appear and absent plans never become debt", () => {
  assert.match(analytics, /task\.status === "todo" && Number\.isFinite\(timestamp\) && timestamp >= now/);
  assert.match(analytics, /interview\.status === "scheduled" && Number\.isFinite\(timestamp\) && timestamp >= now/);
  assert.match(analytics, /职位已归档/);
  assert.match(analytics, /职位已结束/);
  assert.match(analytics, /没有已经定下时间的安排。这里不会替你补一个“应该做”的下一步/);
  assert.doesNotMatch(analytics, /逾期|必须跟进|缺少下一步|未完成\s*\{/);
});

test("settled records are user-controlled and the 319px layout stays readable", () => {
  assert.match(analytics, /<details className="career-reflection-settled">/);
  assert.match(analytics, /按需展开；记录仍完整保留/);
  assert.match(analytics, /className="career-reflection-place-list" role="list" aria-label="进行中的职位位置"/);
  assert.match(analytics, /<article role="listitem"/);
  assert.match(analytics, /<CompanyMark company=\{job\.company\} small decorative \/>/);
  assert.match(css, /\.career-reflection-settled > summary\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.career-reflection-settled > summary:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /\.career-reflection-place-list article > span\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-reflection-place-list article\s*\{\s*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(css, /\.career-reflection-place-list article > \.career-company-mark\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1 \/ 4/s);
  assert.match(css, /\.career-reflection-place-list article > div\s*\{\s*grid-column:\s*2/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-reflection-place-list article > span\s*\{\s*grid-column:\s*2/);
});
