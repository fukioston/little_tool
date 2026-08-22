import {
  commitCareerContactWrite,
  inspectCareerContactWrite,
  prepareCareerContactArchive,
  prepareCareerContactCreate,
  prepareCareerContactInteraction,
  prepareCareerContactRestore,
  prepareCareerContactTask,
  prepareCareerContactUpdate,
  type CareerContactDisplayedExpected,
  type CareerContactWriteReceipt,
} from "@/lib/career/contact-writes";
import {
  commitCareerImportWrite,
  inspectCareerImportWrite,
  prepareCareerImportWrite,
  type CareerImportDisplayedExpected,
  type CareerImportWriteReceipt,
} from "@/lib/career/import-writes";
import {
  commitCareerMaterialWrite,
  garbageCollectCareerMaterialFileCleanupCapability,
  inspectCareerMaterialFileCleanup,
  inspectCareerMaterialWrite,
  prepareCareerMaterialDeleteWriteForUi,
  prepareCareerMaterialSaveWrite,
  retryCareerMaterialFileCleanup,
  type CareerMaterialDeleteUiDisplayedExpected,
  type CareerMaterialFileCleanupGarbageCollectionResult,
  type CareerMaterialFileCleanupInspection,
  type CareerMaterialFileCleanupResult,
  type CareerMaterialFileCleanupTicket,
  type CareerMaterialSaveDisplayedExpected,
  type CareerMaterialSavePrepareOptions,
  type CareerMaterialWriteReceipt,
} from "@/lib/career/material-writes";
import type {
  CreateCareerContactInput,
  CreateCareerContactTaskInput,
  RecordCareerContactInteractionInput,
  UpdateCareerContactInput,
} from "@/lib/career/contacts";
import type { CareerImportCommitItem } from "@/lib/career/imports";
import type { CareerMaterialWriteSaveInput } from "@/lib/career/material-writes";
import type { CareerWriteInspection } from "@/lib/career/write-marker";
import type { CareerContactImportMaterialWriteReceipt } from
  "./contact-import-material-write-journal";

export type CareerContactImportMaterialOwner =
  | "contact"
  | "import"
  | "material";

export type CareerContactImportMaterialInspection =
  | CareerWriteInspection
  | "exact_saved_cleanup_pending"
  | "exact_saved_completed";

export type CareerContactImportMaterialCommitResult = Readonly<{
  outcome: "saved" | "already_saved" | "changed" | "outcome_uncertain";
  receipt: CareerContactImportMaterialWriteReceipt;
  entityId: string;
  retryable?: boolean;
  privateFinalize?: "completed" | "cleanup_pending";
  cleanupPending?: true;
  cleanupRetryable?: true;
}>;

export function careerContactImportMaterialOwner(
  receipt: CareerContactImportMaterialWriteReceipt,
): CareerContactImportMaterialOwner {
  if (receipt.purpose === "career-contact-write") return "contact";
  if (receipt.purpose === "career-import-write") return "import";
  return "material";
}

export function careerContactImportMaterialEntityId(
  receipt: CareerContactImportMaterialWriteReceipt,
): string {
  if (receipt.purpose === "career-import-write") return receipt.operationId;
  if (receipt.purpose === "career-material-write") {
    return receipt.kind === "material-save"
      ? receipt.after.material.id
      : receipt.before.material.id;
  }
  if (receipt.kind === "contact-create") return receipt.after.contact.id;
  if (receipt.kind === "contact-interaction-create") {
    return receipt.after.interaction?.id ?? receipt.after.contact.id;
  }
  if (receipt.kind === "contact-task-create") {
    return receipt.after.task?.id ?? receipt.after.contact.id;
  }
  return receipt.before.contact?.id ?? receipt.after.contact.id;
}

export function careerContactImportMaterialLabel(
  receipt: CareerContactImportMaterialWriteReceipt,
): string {
  switch (receipt.kind) {
    case "contact-create": return "新联系人";
    case "contact-update": return "联系人资料";
    case "contact-archive": return "联系人归档";
    case "contact-restore": return "联系人恢复";
    case "contact-interaction-create": return "联系记录";
    case "contact-task-create": return "联系人待办";
    case "job-import-batch": return "职位导入";
    case "material-save": return "材料保存";
    case "material-delete": return "材料删除";
  }
}

export async function inspectCareerContactImportMaterialWrite(
  receipt: CareerContactImportMaterialWriteReceipt,
): Promise<CareerContactImportMaterialInspection> {
  if (receipt.purpose === "career-contact-write") {
    return inspectCareerContactWrite(receipt);
  }
  if (receipt.purpose === "career-import-write") {
    return inspectCareerImportWrite(receipt);
  }
  return inspectCareerMaterialWrite(receipt);
}

export async function commitCareerContactImportMaterialWrite(
  receipt: CareerContactImportMaterialWriteReceipt,
): Promise<CareerContactImportMaterialCommitResult> {
  if (receipt.purpose === "career-contact-write") {
    return commitCareerContactWrite(receipt);
  }
  if (receipt.purpose === "career-import-write") {
    return commitCareerImportWrite(receipt);
  }
  return commitCareerMaterialWrite(receipt);
}

export function materialWriteNeedsCleanup(
  result: CareerContactImportMaterialCommitResult,
): boolean {
  return result.receipt.purpose === "career-material-write" &&
    result.privateFinalize === "cleanup_pending";
}

export {
  garbageCollectCareerMaterialFileCleanupCapability,
  inspectCareerMaterialFileCleanup,
  prepareCareerContactArchive,
  prepareCareerContactCreate,
  prepareCareerContactInteraction,
  prepareCareerContactRestore,
  prepareCareerContactTask,
  prepareCareerContactUpdate,
  prepareCareerImportWrite,
  prepareCareerMaterialDeleteWriteForUi,
  prepareCareerMaterialSaveWrite,
  retryCareerMaterialFileCleanup,
};

export type {
  CareerContactDisplayedExpected,
  CareerContactWriteReceipt,
  CareerImportDisplayedExpected,
  CareerImportWriteReceipt,
  CareerMaterialDeleteUiDisplayedExpected,
  CareerMaterialFileCleanupGarbageCollectionResult,
  CareerMaterialFileCleanupInspection,
  CareerMaterialFileCleanupResult,
  CareerMaterialFileCleanupTicket,
  CareerMaterialSaveDisplayedExpected,
  CareerMaterialSavePrepareOptions,
  CareerMaterialWriteReceipt,
  CareerMaterialWriteSaveInput,
  CareerImportCommitItem,
  CreateCareerContactInput,
  CreateCareerContactTaskInput,
  RecordCareerContactInteractionInput,
  UpdateCareerContactInput,
};
