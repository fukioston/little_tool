import type { CareerContactDetail } from "@/lib/career/contacts";
import type {
  CareerContactDisplayedExpected,
  CareerContactWriteReceipt,
} from "@/lib/career/contact-writes";
import {
  careerImportExpectedActivity,
  careerImportExpectedJob,
  type CareerImportCommitItem,
} from "@/lib/career/imports";
import type {
  CareerImportDisplayedExpected,
  CareerImportWriteReceipt,
} from "@/lib/career/import-writes";
import type {
  CareerMaterialDeleteUiDisplayedExpected,
  CareerMaterialSaveDisplayedExpected,
  CareerMaterialWriteReceipt,
} from "@/lib/career/material-writes";
import type {
  CareerUiData,
  Job,
} from "@/lib/career/types";
import type { CareerWriteGenerationExpectation } from
  "@/lib/career/write-marker";
import type { CareerContactImportMaterialWriteReceipt } from
  "./contact-import-material-write-journal";

export type CareerContactImportMaterialSettlement = Readonly<{
  outcome: "saved" | "changed" | "discarded";
  receipt: CareerContactImportMaterialWriteReceipt;
}>;

export type CareerContactImportMaterialSettlementLifecycle = Readonly<{
  onPrepared?: (receipt: CareerContactImportMaterialWriteReceipt) => void;
  onSettled?: (settlement: CareerContactImportMaterialSettlement) => void;
  onAbandonChanged?: (
    receipt: CareerContactImportMaterialWriteReceipt,
  ) => void;
}>;

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
}

function ownershipKey(
  receipt: CareerContactImportMaterialWriteReceipt,
): string {
  return canonicalValue(receipt);
}

/** Receipt-exact ownership; operationId equality alone is never authority. */
export function createCareerContactImportMaterialSettlementRegistry() {
  const owned = new Map<string, string>();
  const callbacks = new Map<string, Readonly<{
    receiptKey: string;
    lifecycle: CareerContactImportMaterialSettlementLifecycle;
  }>>();
  const changedNotified = new Set<string>();
  return {
    remember(
      receipt: CareerContactImportMaterialWriteReceipt,
      lifecycle?: CareerContactImportMaterialSettlementLifecycle,
    ) {
      const receiptKey = ownershipKey(receipt);
      owned.set(receipt.operationId, receiptKey);
      if (lifecycle) {
        callbacks.set(receipt.operationId, { receiptKey, lifecycle });
      }
      try { lifecycle?.onPrepared?.(receipt); }
      catch { /* UI callbacks cannot weaken the durable receipt. */ }
    },
    ownsExact(receipt: CareerContactImportMaterialWriteReceipt): boolean {
      return owned.get(receipt.operationId) === ownershipKey(receipt);
    },
    notify(
      receipt: CareerContactImportMaterialWriteReceipt,
      outcome: CareerContactImportMaterialSettlement["outcome"],
    ): boolean {
      const receiptKey = ownershipKey(receipt);
      if (owned.get(receipt.operationId) !== receiptKey) return false;
      const registered = callbacks.get(receipt.operationId);
      const lifecycle = registered?.receiptKey === receiptKey
        ? registered.lifecycle
        : undefined;
      if (outcome === "changed") {
        if (changedNotified.has(receiptKey)) return true;
        changedNotified.add(receiptKey);
      } else {
        callbacks.delete(receipt.operationId);
        changedNotified.delete(receiptKey);
      }
      try { lifecycle?.onSettled?.({ receipt, outcome }); }
      catch { /* Unmounted callers do not change durable authority. */ }
      return true;
    },
    abandonChanged(receipt: CareerContactImportMaterialWriteReceipt): boolean {
      const receiptKey = ownershipKey(receipt);
      if (owned.get(receipt.operationId) !== receiptKey) return false;
      const registered = callbacks.get(receipt.operationId);
      try {
        if (registered?.receiptKey === receiptKey) {
          registered.lifecycle.onAbandonChanged?.(receipt);
        }
      } catch { /* Explicit abandonment remains terminal. */ }
      return true;
    },
    forget(receipt: CareerContactImportMaterialWriteReceipt): boolean {
      const receiptKey = ownershipKey(receipt);
      if (owned.get(receipt.operationId) !== receiptKey) return false;
      owned.delete(receipt.operationId);
      callbacks.delete(receipt.operationId);
      changedNotified.delete(receiptKey);
      return true;
    },
  } as const;
}

export type CareerContactImportMaterialReadEnvelope = Readonly<{
  generation: CareerWriteGenerationExpectation;
  data: CareerUiData;
}>;

/** E1-S-E2 generation gate for the redacted whole-data read. */
export function createCareerContactImportMaterialReadEnvelope(
  expectedBefore: CareerWriteGenerationExpectation,
  data: CareerUiData,
  expectedAfter: CareerWriteGenerationExpectation,
): CareerContactImportMaterialReadEnvelope | null {
  if (expectedBefore.generationId !== expectedAfter.generationId ||
    expectedBefore.generationSequence !== expectedAfter.generationSequence) {
    return null;
  }
  return { generation: { ...expectedAfter }, data };
}

/**
 * Dirty views accept semantic clones and an exact owned receipt refresh. An
 * unrelated broadcast never silently rebases local input.
 */
export function careerContactImportMaterialReadApplyDecision(input: Readonly<{
  current: CareerContactImportMaterialReadEnvelope | null;
  next: CareerContactImportMaterialReadEnvelope;
  dirtyEditorCount: number;
  committedReceipt?: CareerContactImportMaterialWriteReceipt;
  committedReceiptOwned?: boolean;
}>): "apply" | "defer" {
  if (input.dirtyEditorCount === 0 || !input.current) return "apply";
  if (input.current.generation.generationId !==
      input.next.generation.generationId ||
    input.current.generation.generationSequence !==
      input.next.generation.generationSequence) return "defer";
  if (canonicalValue(input.current.data) === canonicalValue(input.next.data)) {
    return "apply";
  }
  return input.committedReceipt && input.committedReceiptOwned === true
    ? "apply"
    : "defer";
}

export function careerContactDisplayedExpected(
  generation: CareerWriteGenerationExpectation,
  detail: CareerContactDetail | null,
  jobs: readonly Readonly<Job>[] = [],
): CareerContactDisplayedExpected {
  if (detail) {
    const coveredJobs = new Map(detail.jobs.map((job) => [job.id, job]));
    jobs.forEach((job) => coveredJobs.set(job.id, job));
    return {
        ...generation,
        contact: detail.contact,
        associations: detail.associations,
        jobs: [...coveredJobs.values()],
      };
  }
  return {
    ...generation,
    contact: null,
    associations: [],
    jobs,
  };
}

export function careerImportDisplayedExpected(
  generation: CareerWriteGenerationExpectation,
  data: CareerUiData,
  items: readonly CareerImportCommitItem[],
): CareerImportDisplayedExpected {
  const jobs = new Map(data.jobs.map((row) => [row.id, row]));
  const activities = new Map(data.activities.map((row) => [row.id, row]));
  const stageIds = [...new Set(items.map(({ preview }) =>
    preview.candidate.stageId))].sort();
  const stages = stageIds.flatMap((id) => {
    const stage = data.stages.find((row) => row.id === id);
    return stage ? [stage] : [];
  });
  const rows = [...new Map(items.map((item) =>
    [item.preview.importOperationId, item] as const)).values()]
    .sort((left, right) => left.preview.importOperationId.localeCompare(
      right.preview.importOperationId,
    ))
    .map(({ preview }) => {
      const expectedJob = careerImportExpectedJob(preview);
      const expectedActivity = careerImportExpectedActivity(preview);
      return {
        importOperationId: preview.importOperationId,
        job: jobs.get(expectedJob.id) ?? null,
        activity: activities.get(expectedActivity.id) ?? null,
      };
    });
  return { ...generation, rows, stages };
}

export function careerMaterialSaveDisplayedExpected(
  generation: CareerWriteGenerationExpectation,
  linkedJob: Readonly<Job> | null,
): CareerMaterialSaveDisplayedExpected {
  return { ...generation, material: null, linkedJob };
}

export function careerMaterialDeleteDisplayedExpected(
  generation: CareerWriteGenerationExpectation,
  material: CareerUiData["materials"][number],
  linkedJob: Readonly<Job> | null,
): CareerMaterialDeleteUiDisplayedExpected {
  return { ...generation, material, linkedJob };
}

export type CareerContactReceipt = CareerContactWriteReceipt;
export type CareerImportReceipt = CareerImportWriteReceipt;
export type CareerMaterialReceipt = CareerMaterialWriteReceipt;
