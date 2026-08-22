import type { SqlStatement } from "@/lib/local-db/types";
import type { Activity, Job, Stage } from "./types";
import {
  assertCareerImportPreviewIntegrity,
  careerImportExpectedActivity,
  careerImportExpectedJob,
  type CareerImportCommitItem,
  type CareerJobImportPreview,
} from "./imports";
import {
  CAREER_WRITE_RECEIPT_MAX_JSON_BYTES,
  CAREER_WRITE_RECEIPT_VERSION,
  type CareerWriteCommitResult,
  type CareerWriteGenerationExpectation,
  type CareerWriteInspection,
  type CareerWriteReceiptBase,
  type CareerWriteStorageRuntime,
  abortUnless,
  careerWriteError,
  careerWriteReceiptHashIsValid,
  compareSqliteBinaryText,
  defaultCareerWriteStorageRuntime,
  exactCareerWriteMarker,
  exactKeys,
  generatedCareerWriteOperationId,
  isCanonicalIsoTimestamp,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  jsonClone,
  markerAbsentPredicate,
  markerStatement,
  readCareerWriteMarker,
  readCurrentCareerWriteGeneration,
  requireCurrentCareerWriteGeneration,
  safeCareerWriteBroadcast,
  sameCareerWriteGeneration,
  sealCareerWriteReceipt,
  strictlyLaterTimestamp,
  withCareerWritePrepareLock,
} from "./write-marker";

const PURPOSE = "career-import-write" as const;
const KIND = "job-import-batch" as const;
const MAX_IMPORT_ROWS = 2_000;
const IMPORT_OPERATION_PATTERN = /^import_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PREVIEW_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JOB_KEYS = [
  "id", "company", "role", "location", "source", "source_url", "stage_id",
  "priority", "salary", "work_mode", "description", "applied_at", "deadline",
  "contact_name", "note", "tags", "created_at", "updated_at", "archived",
  "position", "archived_at", "ended_at", "archived_operation_id",
  "ended_operation_id",
] as const;
const ACTIVITY_KEYS = ["id", "job_id", "type", "detail", "created_at"] as const;
const STAGE_KEYS = ["id", "name", "color", "position", "is_terminal", "hidden"] as const;

export type CareerImportDisplayedRow = Readonly<{
  importOperationId: string;
  job: Readonly<Job> | null;
  activity: Readonly<Activity> | null;
}>;

export type CareerImportDisplayedExpected = CareerWriteGenerationExpectation & Readonly<{
  /** Exact full rows for every unique import operation in the batch. */
  rows: readonly CareerImportDisplayedRow[];
  /** Exact full stage rows referenced by the previews, and no others. */
  stages: readonly Readonly<Stage>[];
}>;

type ImportAfterRow = Readonly<{
  importOperationId: string;
  previewFingerprint: string;
  preview: CareerJobImportPreview;
  job: Readonly<Job>;
  activity: Readonly<Activity>;
}>;

export type CareerImportWriteReceipt = CareerWriteReceiptBase<
  typeof PURPOSE,
  typeof KIND,
  CareerImportDisplayedExpected,
  CareerWriteGenerationExpectation & Readonly<{ rows: readonly ImportAfterRow[] }>
>;

export type CareerImportWriteResult = CareerWriteCommitResult<CareerImportWriteReceipt>;

function rows<Row extends object>(
  runtime: CareerWriteStorageRuntime,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return runtime.query<Row>(sql, params).then((result) => result.rows);
}

function sameRow<Row extends object>(left: Row, right: Row, keys: readonly (keyof Row)[]): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function sortStages(value: readonly Readonly<Stage>[]): Stage[] {
  return value.map((row) => ({ ...row })).sort((left, right) => compareSqliteBinaryText(left.id, right.id));
}

function sortDisplayedRows(value: readonly CareerImportDisplayedRow[]): CareerImportDisplayedRow[] {
  return value.map((row) => ({
    importOperationId: row.importOperationId,
    job: row.job ? { ...row.job } : null,
    activity: row.activity ? { ...row.activity } : null,
  })).sort((left, right) => compareSqliteBinaryText(left.importOperationId, right.importOperationId));
}

function sortAfterRows(value: readonly ImportAfterRow[]): ImportAfterRow[] {
  return value.map((row) => ({
    ...row,
    job: { ...row.job },
    activity: { ...row.activity },
  })).sort((left, right) => compareSqliteBinaryText(left.importOperationId, right.importOperationId));
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...JOB_KEYS])) return false;
  const row = value as Job;
  return JOB_KEYS.filter((key) => ![
    "priority", "position", "archived", "applied_at", "deadline", "archived_at",
    "ended_at", "archived_operation_id", "ended_operation_id",
  ].includes(key)).every((key) => typeof row[key] === "string") &&
    Number.isSafeInteger(row.priority) && row.priority >= 1 && row.priority <= 3 &&
    Number.isSafeInteger(row.position) && (row.archived === 0 || row.archived === 1) &&
    [row.applied_at, row.deadline, row.archived_at, row.ended_at].every((timestamp) =>
      timestamp === null || isCanonicalIsoTimestamp(timestamp)) &&
    [row.archived_operation_id, row.ended_operation_id].every((id) => id === null || typeof id === "string") &&
    isCanonicalIsoTimestamp(row.created_at) && isCanonicalIsoTimestamp(row.updated_at);
}

function isActivity(value: unknown): value is Activity {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...ACTIVITY_KEYS])) return false;
  const row = value as Activity;
  return typeof row.id === "string" && (row.job_id === null || typeof row.job_id === "string") &&
    typeof row.type === "string" && typeof row.detail === "string" && isCanonicalIsoTimestamp(row.created_at);
}

function isStage(value: unknown): value is Stage {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [...STAGE_KEYS])) return false;
  const row = value as Stage;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.color === "string" &&
    Number.isSafeInteger(row.position) && (row.is_terminal === 0 || row.is_terminal === 1) &&
    (row.hidden === 0 || row.hidden === 1);
}

function isDisplayedRow(value: unknown): value is CareerImportDisplayedRow {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["importOperationId", "job", "activity"])) return false;
  const row = value as CareerImportDisplayedRow;
  return IMPORT_OPERATION_PATTERN.test(row.importOperationId) && (row.job === null || isJob(row.job)) &&
    (row.activity === null || isActivity(row.activity));
}

function entityIds(importOperationId: string): { jobId: string; activityId: string } {
  const match = IMPORT_OPERATION_PATTERN.exec(importOperationId);
  if (!match) throw careerWriteError("invalid_input", "导入操作标识无效。");
  return { jobId: `job_${match[1].toLowerCase()}`, activityId: `activity_${match[1].toLowerCase()}` };
}

function isReceipt(value: unknown): value is CareerImportWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "purpose", "version", "kind", "operationId", "generationId", "generationSequence",
    "operationAt", "before", "after", "projectionSha256",
  ])) return false;
  const receipt = value as CareerImportWriteReceipt;
  if (receipt.purpose !== PURPOSE || receipt.version !== CAREER_WRITE_RECEIPT_VERSION ||
    receipt.kind !== KIND || !isCareerWriteOperationId(receipt.operationId, PURPOSE) ||
    typeof receipt.operationAt !== "string" || !isCareerWriteGeneration({
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
    }) || !receipt.before || typeof receipt.before !== "object" || Array.isArray(receipt.before) ||
    !exactKeys(receipt.before, ["generationId", "generationSequence", "rows", "stages"]) ||
    !isCareerWriteGeneration({
      generationId: receipt.before.generationId,
      generationSequence: receipt.before.generationSequence,
    }) || !Array.isArray(receipt.before.rows) || !receipt.before.rows.every(isDisplayedRow) ||
    !Array.isArray(receipt.before.stages) || !receipt.before.stages.every(isStage) ||
    !receipt.after || typeof receipt.after !== "object" || Array.isArray(receipt.after) ||
    !exactKeys(receipt.after, ["generationId", "generationSequence", "rows"]) ||
    !isCareerWriteGeneration({
      generationId: receipt.after.generationId,
      generationSequence: receipt.after.generationSequence,
    }) || !Array.isArray(receipt.after.rows) || receipt.after.rows.length === 0 ||
    receipt.after.rows.length > MAX_IMPORT_ROWS || !sameCareerWriteGeneration(receipt, receipt.before) ||
    !sameCareerWriteGeneration(receipt, receipt.after)) return false;
  return receipt.after.rows.every((row) => row && typeof row === "object" &&
    exactKeys(row, ["importOperationId", "previewFingerprint", "preview", "job", "activity"]) &&
    typeof row.importOperationId === "string" && typeof row.previewFingerprint === "string" &&
    Boolean(row.preview) && typeof row.preview === "object" && !Array.isArray(row.preview) &&
    isJob(row.job) && isActivity(row.activity)) && receiptSemanticsValid(receipt);
}

function idsAreUniqueAndSqliteSorted(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length && ids.every((id, index) =>
    index === 0 || compareSqliteBinaryText(ids[index - 1], id) < 0);
}

function freshImportedJob(job: Job, activity: Activity): boolean {
  return job.created_at === job.updated_at && job.applied_at === null && job.deadline === null &&
    job.contact_name === "" && job.note === "" && job.archived === 0 && job.position === 0 &&
    job.archived_at === null && job.ended_at === null && job.archived_operation_id === null &&
    job.ended_operation_id === null && activity.job_id === job.id && activity.type === "import" &&
    activity.detail === `导入了 ${job.company} · ${job.role}` && activity.created_at === job.created_at;
}

function receiptSemanticsValid(receipt: CareerImportWriteReceipt): boolean {
  const beforeRows = receipt.before.rows;
  const afterRows = receipt.after.rows;
  if (!isCanonicalIsoTimestamp(receipt.operationAt) || beforeRows.length !== afterRows.length ||
    beforeRows.length === 0 || beforeRows.length > MAX_IMPORT_ROWS) return false;
  const beforeIds = beforeRows.map(({ importOperationId }) => importOperationId);
  const afterIds = afterRows.map(({ importOperationId }) => importOperationId);
  const stageIds = receipt.before.stages.map(({ id }) => id);
  const fingerprints = afterRows.map(({ previewFingerprint }) => previewFingerprint);
  if (!idsAreUniqueAndSqliteSorted(beforeIds) || !idsAreUniqueAndSqliteSorted(afterIds) ||
    !idsAreUniqueAndSqliteSorted(stageIds) || new Set(fingerprints).size !== fingerprints.length ||
    beforeIds.some((id, index) => id !== afterIds[index])) return false;
  const requiredStages = [...new Set(afterRows.map(({ job }) => job.stage_id))].sort(compareSqliteBinaryText);
  if (stageIds.length !== requiredStages.length || stageIds.some((id, index) => id !== requiredStages[index])) return false;
  for (let index = 0; index < beforeRows.length; index += 1) {
    const before = beforeRows[index];
    const after = afterRows[index];
    if (before.importOperationId !== before.importOperationId.toLowerCase() ||
      !PREVIEW_FINGERPRINT_PATTERN.test(after.previewFingerprint) ||
      after.previewFingerprint !== after.preview.previewFingerprint ||
      after.importOperationId !== after.preview.importOperationId) return false;
    let ids: ReturnType<typeof entityIds>;
    try { ids = entityIds(before.importOperationId); } catch { return false; }
    if (after.job.id !== ids.jobId || after.activity.id !== ids.activityId ||
      !freshImportedJob(after.job, after.activity) ||
      !(Date.parse(receipt.operationAt) > Date.parse(after.job.created_at))) return false;
    const bothFresh = before.job === null && before.activity === null;
    const bothExisting = before.job !== null && before.activity !== null;
    if (!bothFresh && !bothExisting) return false;
    if (bothExisting && (!sameRow(before.job!, after.job, JOB_KEYS) ||
      !sameRow(before.activity!, after.activity, ACTIVITY_KEYS))) return false;
  }
  return true;
}

async function receiptPreviewsValid(receipt: CareerImportWriteReceipt): Promise<boolean> {
  try {
    for (const row of receipt.after.rows) {
      await assertCareerImportPreviewIntegrity(row.preview);
      if (!sameRow(row.job, careerImportExpectedJob(row.preview) as Job, JOB_KEYS) ||
        !sameRow(row.activity, careerImportExpectedActivity(row.preview) as Activity, ACTIVITY_KEYS) ||
        !(Date.parse(receipt.operationAt) > Date.parse(row.preview.createdAt))) return false;
    }
    return true;
  } catch { return false; }
}

async function readJob(runtime: CareerWriteStorageRuntime, id: string): Promise<Job | null> {
  const result = await rows<Job>(runtime, `SELECT ${JOB_KEYS.join(",")} FROM career_jobs WHERE id=? ORDER BY id LIMIT 2`, [id]);
  if (result.length > 1) throw new Error("职位标识不唯一。");
  return result[0] ? { ...result[0] } : null;
}

async function readActivity(runtime: CareerWriteStorageRuntime, id: string): Promise<Activity | null> {
  const result = await rows<Activity>(runtime, `SELECT ${ACTIVITY_KEYS.join(",")} FROM career_activity WHERE id=? ORDER BY id LIMIT 2`, [id]);
  if (result.length > 1) throw new Error("动态标识不唯一。");
  return result[0] ? { ...result[0] } : null;
}

async function readStage(runtime: CareerWriteStorageRuntime, id: string): Promise<Stage | null> {
  const result = await rows<Stage>(runtime, `SELECT ${STAGE_KEYS.join(",")} FROM career_stages WHERE id=? ORDER BY id LIMIT 2`, [id]);
  if (result.length > 1) throw new Error("阶段标识不唯一。");
  return result[0] ? { ...result[0] } : null;
}

async function displayedExact(runtime: CareerWriteStorageRuntime, displayed: CareerImportDisplayedExpected): Promise<boolean> {
  for (const expected of displayed.stages) {
    const actual = await readStage(runtime, expected.id);
    if (!actual || !sameRow(actual, expected, STAGE_KEYS)) return false;
  }
  for (const expected of displayed.rows) {
    const { jobId: targetJobId, activityId: targetActivityId } = entityIds(expected.importOperationId);
    const [job, activity] = await Promise.all([
      readJob(runtime, targetJobId),
      readActivity(runtime, targetActivityId),
    ]);
    if ((expected.job === null) !== (job === null) || (expected.activity === null) !== (activity === null) ||
      (job && expected.job && !sameRow(job, expected.job, JOB_KEYS)) ||
      (activity && expected.activity && !sameRow(activity, expected.activity, ACTIVITY_KEYS))) return false;
  }
  return true;
}

function sqlExact(table: string, keys: readonly string[], row: Record<string, unknown>): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map((key) => `${key} IS ?`).join(" AND ")})`,
    params: keys.map((key) => row[key]),
  };
}

function beforeStatements(receipt: CareerImportWriteReceipt): SqlStatement[] {
  const statements: SqlStatement[] = [abortUnless(markerAbsentPredicate(receipt.operationId))];
  for (const stage of receipt.before.stages) {
    statements.push(abortUnless(sqlExact("career_stages", STAGE_KEYS, stage as unknown as Record<string, unknown>)));
  }
  for (let index = 0; index < receipt.before.rows.length; index += 1) {
    const before = receipt.before.rows[index];
    const after = receipt.after.rows[index];
    statements.push(abortUnless(before.job
      ? sqlExact("career_jobs", JOB_KEYS, before.job as unknown as Record<string, unknown>)
      : { sql: "NOT EXISTS(SELECT 1 FROM career_jobs WHERE id=?)", params: [after.job.id] }));
    statements.push(abortUnless(before.activity
      ? sqlExact("career_activity", ACTIVITY_KEYS, before.activity as unknown as Record<string, unknown>)
      : { sql: "NOT EXISTS(SELECT 1 FROM career_activity WHERE id=?)", params: [after.activity.id] }));
  }
  return statements;
}

function insertJob(job: Job): SqlStatement {
  return {
    sql: `INSERT INTO career_jobs(${JOB_KEYS.join(",")}) VALUES(${JOB_KEYS.map(() => "?").join(",")})`,
    params: JOB_KEYS.map((key) => job[key]),
  };
}

function insertActivity(activity: Activity): SqlStatement {
  return {
    sql: `INSERT INTO career_activity(${ACTIVITY_KEYS.join(",")}) VALUES(${ACTIVITY_KEYS.map(() => "?").join(",")})`,
    params: ACTIVITY_KEYS.map((key) => activity[key]),
  };
}

function receiptStatements(receipt: CareerImportWriteReceipt): SqlStatement[] {
  const statements = beforeStatements(receipt);
  receipt.before.rows.forEach((before, index) => {
    if (before.job === null) statements.push(insertJob(receipt.after.rows[index].job));
    if (before.activity === null) statements.push(insertActivity(receipt.after.rows[index].activity));
  });
  statements.push(markerStatement(receipt, receipt.operationId));
  return statements;
}

function validateDisplayed(displayed: CareerImportDisplayedExpected): void {
  const rowIds = displayed.rows.map((row) => row.importOperationId);
  const stageIds = displayed.stages.map((row) => row.id);
  if (new Set(rowIds).size !== rowIds.length || new Set(stageIds).size !== stageIds.length) {
    throw careerWriteError("invalid_input", "导入显示快照包含重复标识。");
  }
  for (const row of displayed.rows) {
    const ids = entityIds(row.importOperationId);
    if ((row.job === null) !== (row.activity === null) ||
      (row.job && row.activity && (row.job.id !== ids.jobId || row.activity.id !== ids.activityId ||
        row.activity.job_id !== row.job.id))) {
      throw careerWriteError("changed", "导入目标存在不完整记录；没有准备写入。");
    }
  }
}

export function createCareerImportWriteStorageService(
  runtime: CareerWriteStorageRuntime = defaultCareerWriteStorageRuntime,
) {
  async function prepare(
    itemsValue: readonly CareerImportCommitItem[],
    displayedValue: CareerImportDisplayedExpected,
  ): Promise<CareerImportWriteReceipt> {
    const items = jsonClone<readonly CareerImportCommitItem[]>(itemsValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "导入批次");
    const displayedInput = jsonClone<CareerImportDisplayedExpected>(displayedValue, CAREER_WRITE_RECEIPT_MAX_JSON_BYTES, "导入显示快照");
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_IMPORT_ROWS) {
      throw careerWriteError("invalid_input", "每批需要包含 1 到 2000 个导入项目。");
    }
    const unique = new Map<string, CareerImportCommitItem>();
    for (const item of items) {
      await assertCareerImportPreviewIntegrity(item.preview);
      if (item.currentSourceFingerprint !== item.preview.sourceFingerprint) {
        throw careerWriteError("changed", "导入来源已经变化；没有准备写入。");
      }
      const previous = unique.get(item.preview.importOperationId);
      if (previous && previous.preview.previewFingerprint !== item.preview.previewFingerprint) {
        throw careerWriteError("invalid_input", "同一导入标识对应了不同预览。");
      }
      unique.set(item.preview.importOperationId, item);
    }
    const ordered = [...unique.values()].sort((left, right) =>
      compareSqliteBinaryText(left.preview.importOperationId, right.preview.importOperationId));
    return withCareerWritePrepareLock(runtime, async () => {
      const displayed: CareerImportDisplayedExpected = {
        ...displayedInput,
        rows: sortDisplayedRows(displayedInput.rows),
        stages: sortStages(displayedInput.stages),
      };
      validateDisplayed(displayed);
      const expectedIds = ordered.map(({ preview }) => preview.importOperationId);
      if (displayed.rows.length !== ordered.length ||
        displayed.rows.some((row, index) => row.importOperationId !== expectedIds[index])) {
        throw careerWriteError("invalid_input", "导入显示快照没有完整覆盖这批预览。");
      }
      const requiredStageIds = [...new Set(ordered.map(({ preview }) => preview.candidate.stageId))]
        .sort(compareSqliteBinaryText);
      if (displayed.stages.length !== requiredStageIds.length ||
        displayed.stages.some((stage, index) => stage.id !== requiredStageIds[index])) {
        throw careerWriteError("invalid_input", "导入阶段快照没有完整覆盖这批预览。");
      }
      const generation = await readCurrentCareerWriteGeneration(runtime);
      requireCurrentCareerWriteGeneration(generation, displayed);
      if (!await displayedExact(runtime, displayed)) {
        throw careerWriteError("changed", "导入目标或阶段已经变化；没有准备写入。");
      }
      const afterRows = sortAfterRows(ordered.map(({ preview }) => ({
        importOperationId: preview.importOperationId,
        previewFingerprint: preview.previewFingerprint,
        preview,
        job: { ...careerImportExpectedJob(preview) } as Job,
        activity: { ...careerImportExpectedActivity(preview) } as Activity,
      })));
      for (let index = 0; index < displayed.rows.length; index += 1) {
        const before = displayed.rows[index];
        const after = afterRows[index];
        if (before.job && !sameRow(before.job, after.job, JOB_KEYS) ||
          before.activity && !sameRow(before.activity, after.activity, ACTIVITY_KEYS)) {
          throw careerWriteError("changed", "导入标识已用于不同内容；没有准备写入。");
        }
      }
      const operationId = generatedCareerWriteOperationId(runtime, PURPOSE);
      if (await readCareerWriteMarker(runtime, operationId)) {
        throw careerWriteError("changed", "导入批次标识已被占用；没有准备写入。");
      }
      const operationAt = strictlyLaterTimestamp(runtime.now(), ordered.map(({ preview }) => preview.createdAt));
      return sealCareerWriteReceipt<CareerImportWriteReceipt>({
        purpose: PURPOSE,
        version: CAREER_WRITE_RECEIPT_VERSION,
        kind: KIND,
        operationId,
        ...generation,
        operationAt,
        before: displayed,
        after: { ...generation, rows: afterRows },
      });
    });
  }

  async function stateUnlocked(receipt: CareerImportWriteReceipt): Promise<Exclude<CareerWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readCurrentCareerWriteGeneration(runtime);
    if (!sameCareerWriteGeneration(generation, receipt)) return "changed";
    const marker = await readCareerWriteMarker(runtime, receipt.operationId);
    if (marker) return exactCareerWriteMarker(marker, receipt, receipt.operationId) ? "exact_saved" : "changed";
    return await displayedExact(runtime, receipt.before) ? "expected" : "changed";
  }

  async function parse(value: unknown): Promise<CareerImportWriteReceipt | null> {
    try {
      const receipt = jsonClone<CareerImportWriteReceipt>(value);
      return isReceipt(receipt) && await careerWriteReceiptHashIsValid(receipt) &&
        await receiptPreviewsValid(receipt) ? receipt : null;
    } catch { return null; }
  }

  async function inspect(value: unknown): Promise<CareerWriteInspection> {
    const receipt = await parse(value);
    if (!receipt) return "invalid_receipt";
    try { return await runtime.withExclusiveLock(() => stateUnlocked(receipt)); }
    catch { return "still_unknown"; }
  }

  async function commit(value: unknown): Promise<CareerImportWriteResult> {
    const receipt = await parse(value);
    if (!receipt) throw careerWriteError("invalid_receipt", "导入写入回执无效；没有改动资料。");
    let entered = false;
    try {
      return await runtime.withExclusiveLock(async () => {
        entered = true;
        const before = await stateUnlocked(receipt);
        if (before === "exact_saved") {
          safeCareerWriteBroadcast(runtime, "career-job-imported");
          return { outcome: "already_saved", receipt, entityId: receipt.operationId };
        }
        if (before === "changed") return { outcome: "changed", receipt, entityId: receipt.operationId, retryable: false };
        try { await runtime.batch(receiptStatements(receipt)); }
        catch { /* Inspect the immutable marker after a possible response loss. */ }
        const after = await stateUnlocked(receipt);
        if (after === "exact_saved") {
          safeCareerWriteBroadcast(runtime, "career-job-imported");
          return { outcome: "saved", receipt, entityId: receipt.operationId };
        }
        if (after === "expected") throw careerWriteError("write_failed", "这批导入确定没有提交；可保留原回执重试。", receipt);
        return { outcome: "changed", receipt, entityId: receipt.operationId, retryable: false };
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      if (!entered) throw careerWriteError("lock_unavailable", "无法取得安全写入锁；没有开始导入。", receipt);
      return { outcome: "outcome_uncertain", receipt, entityId: receipt.operationId, retryable: true };
    }
  }

  return {
    prepareCareerImportWrite: prepare,
    inspectCareerImportWrite: inspect,
    commitCareerImportWrite: commit,
  } as const;
}

const defaultService = createCareerImportWriteStorageService();
export const prepareCareerImportWrite = defaultService.prepareCareerImportWrite;
export const inspectCareerImportWrite = defaultService.inspectCareerImportWrite;
export const commitCareerImportWrite = defaultService.commitCareerImportWrite;

export type { CareerJobImportPreview };
