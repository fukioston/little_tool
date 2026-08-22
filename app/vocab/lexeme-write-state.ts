import type {
  VocabLexemeExpectedSet,
  VocabLexemeExpectedState,
  VocabLexemeWriteReceipt,
  VocabStoredLexeme,
  VocabStoredReviewCard,
} from "@/lib/vocab/store";
import type { Lexeme, ReviewCard } from "@/lib/vocab/types";

const STORED_LEXEME_KEYS = [
  "id",
  "headword",
  "normalized_key",
  "pronunciation",
  "gloss_en",
  "explanation_en",
  "explanation_zh",
  "status",
  "starred",
  "notes",
  "lookup_count",
  "created_at",
  "updated_at",
] as const;

const STORED_REVIEW_CARD_KEYS = [
  "id",
  "lexeme_id",
  "state",
  "due_at",
  "interval_days",
  "ease",
  "reps",
  "lapses",
  "last_review_at",
  "algorithm_version",
  "suspended_from_state",
  "suspended_reason",
  "updated_at",
] as const;

export type VocabLexemeBinding = Readonly<{
  display: Lexeme;
  expected: VocabLexemeExpectedState;
}>;

export type VocabLexemeBindingMap = ReadonlyMap<string, VocabLexemeBinding>;

export type VocabLexemeNoteEditor = Readonly<{
  lexemeId: string;
  display: Lexeme;
  expected: VocabLexemeExpectedState;
  baselineNote: string;
  note: string;
  revision: number;
  forceDirty: boolean;
  preparation: VocabLexemeEditorPreparation | null;
  operation: VocabLexemeEditorOperation | null;
}>;

export type VocabLexemeEditorPreparation = Readonly<{
  token: symbol;
  kind: VocabLexemeWriteReceipt["kind"];
  display: Lexeme;
  expected: VocabLexemeExpectedState;
  note: string;
  submittedRevision: number;
}>;

export type VocabLexemeEditorOperation = Readonly<{
  receipt: VocabLexemeWriteReceipt;
  display: Lexeme;
  expected: VocabLexemeExpectedState;
  note: string;
  submittedRevision: number;
}>;

export type VocabLexemeRefreshProtection = Readonly<{
  receipt: VocabLexemeWriteReceipt;
  mode: "before-only" | "after-only" | "any";
}>;

export function sameVocabStoredLexeme(
  left: VocabStoredLexeme,
  right: VocabStoredLexeme,
): boolean {
  return STORED_LEXEME_KEYS.every((key) => left[key] === right[key]);
}

export function sameVocabStoredReviewCard(
  left: VocabStoredReviewCard | null,
  right: VocabStoredReviewCard | null,
): boolean {
  if (left === null || right === null) return left === right;
  return STORED_REVIEW_CARD_KEYS.every((key) => left[key] === right[key]);
}

export function sameVocabLexemeExpectedState(
  left: VocabLexemeExpectedState,
  right: VocabLexemeExpectedState,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    sameVocabStoredLexeme(left.lexeme, right.lexeme) &&
    sameVocabStoredReviewCard(left.reviewCard, right.reviewCard);
}

export function sameVocabLexemeExpectedSet(
  left: VocabLexemeExpectedSet,
  right: VocabLexemeExpectedSet,
): boolean {
  if (
    left.generationId !== right.generationId ||
    left.generationSequence !== right.generationSequence ||
    left.entries.length !== right.entries.length
  ) return false;
  const rightById = new Map(right.entries.map((entry) => [
    entry.lexeme.id,
    entry,
  ] as const));
  if (rightById.size !== right.entries.length) return false;
  const seen = new Set<string>();
  return left.entries.every((entry) => {
    if (seen.has(entry.lexeme.id)) return false;
    seen.add(entry.lexeme.id);
    const other = rightById.get(entry.lexeme.id);
    if (!other) return false;
    return sameVocabStoredLexeme(entry.lexeme, other.lexeme) &&
      sameVocabStoredReviewCard(entry.reviewCard, other.reviewCard);
  });
}

function snapshotReviewCardMatches(
  display: ReviewCard,
  expected: VocabStoredReviewCard,
): boolean {
  return STORED_REVIEW_CARD_KEYS.every((key) => display[key] === expected[key]);
}

export function createVocabLexemeBindings(
  displayLexemes: readonly Lexeme[],
  displayReviewCards: readonly ReviewCard[],
  expectedSet: VocabLexemeExpectedSet,
): Map<string, VocabLexemeBinding> | null {
  if (displayLexemes.length !== expectedSet.entries.length) return null;
  const expectedById = new Map(expectedSet.entries.map((entry) => [
    entry.lexeme.id,
    entry,
  ] as const));
  if (expectedById.size !== expectedSet.entries.length) return null;
  const expectedCardIds = new Set<string>();
  for (const entry of expectedSet.entries) {
    if (!entry.reviewCard) continue;
    if (
      entry.reviewCard.lexeme_id !== entry.lexeme.id ||
      expectedCardIds.has(entry.reviewCard.id)
    ) return null;
    expectedCardIds.add(entry.reviewCard.id);
  }
  const bindings = new Map<string, VocabLexemeBinding>();
  for (const display of displayLexemes) {
    if (bindings.has(display.id)) return null;
    const expectedEntry = expectedById.get(display.id);
    if (!expectedEntry || !sameVocabStoredLexeme(display, expectedEntry.lexeme)) {
      return null;
    }
    bindings.set(display.id, {
      display,
      expected: {
        generationId: expectedSet.generationId,
        generationSequence: expectedSet.generationSequence,
        lexeme: expectedEntry.lexeme,
        reviewCard: expectedEntry.reviewCard,
      },
    });
  }
  const visibleCardIds = new Set<string>();
  const visibleCardLexemeIds = new Set<string>();
  for (const displayCard of displayReviewCards) {
    if (
      visibleCardIds.has(displayCard.id) ||
      visibleCardLexemeIds.has(displayCard.lexeme_id)
    ) return null;
    visibleCardIds.add(displayCard.id);
    visibleCardLexemeIds.add(displayCard.lexeme_id);
    const expectedCard = expectedById.get(displayCard.lexeme_id)?.reviewCard;
    if (
      !expectedCard || expectedCard.id !== displayCard.id ||
      !snapshotReviewCardMatches(displayCard, expectedCard)
    ) {
      return null;
    }
  }
  return bindings;
}

export function getBoundVocabLexemeExpected(
  bindings: VocabLexemeBindingMap,
  display: Lexeme,
): VocabLexemeExpectedState | null {
  const binding = bindings.get(display.id);
  return binding?.display === display ? binding.expected : null;
}

export function createVocabLexemeNoteEditor(
  binding: VocabLexemeBinding,
): VocabLexemeNoteEditor {
  return {
    lexemeId: binding.display.id,
    display: binding.display,
    expected: binding.expected,
    baselineNote: binding.display.notes,
    note: binding.display.notes,
    revision: 0,
    forceDirty: false,
    preparation: null,
    operation: null,
  };
}

export function updateVocabLexemeNoteEditor(
  editor: VocabLexemeNoteEditor,
  note: string,
): VocabLexemeNoteEditor {
  return { ...editor, note, revision: editor.revision + 1 };
}

export function vocabLexemeNoteEditorDirty(
  editor: VocabLexemeNoteEditor | null,
): boolean {
  if (!editor) return false;
  const submittedRevision = editor.operation?.submittedRevision ??
    editor.preparation?.submittedRevision ?? null;
  return editor.forceDirty || editor.note !== editor.baselineNote ||
    (submittedRevision !== null && editor.revision > submittedRevision);
}

function sameSimpleReceiptSnapshot(
  state: VocabLexemeExpectedState,
  snapshot: VocabLexemeWriteReceipt["before"],
): boolean {
  return state.generationId === snapshot.generationId &&
    state.generationSequence === snapshot.generationSequence &&
    sameVocabStoredLexeme(state.lexeme, snapshot.lexeme);
}

function expectedMatchesReceiptSnapshot(
  expected: VocabLexemeExpectedState,
  receipt: VocabLexemeWriteReceipt,
  snapshot: VocabLexemeWriteReceipt["before"],
): boolean {
  if (!sameSimpleReceiptSnapshot(expected, snapshot)) return false;
  return receipt.kind !== "status-set" || (
    "reviewCard" in snapshot &&
    sameVocabStoredReviewCard(expected.reviewCard, snapshot.reviewCard)
  );
}

function expectedMatchesPreparation(
  expected: VocabLexemeExpectedState,
  preparation: VocabLexemeEditorPreparation,
): boolean {
  return sameSimpleReceiptSnapshot(expected, {
    generationId: preparation.expected.generationId,
    generationSequence: preparation.expected.generationSequence,
    lexeme: preparation.expected.lexeme,
  }) && (
    preparation.kind !== "status-set" ||
    sameVocabStoredReviewCard(
      expected.reviewCard,
      preparation.expected.reviewCard,
    )
  );
}

function sameVocabLexemeWriteReceipt(
  left: VocabLexemeWriteReceipt,
  right: VocabLexemeWriteReceipt,
): boolean {
  if (
    left.operationId !== right.operationId || left.kind !== right.kind ||
    left.generationId !== right.generationId ||
    left.generationSequence !== right.generationSequence ||
    left.projectionSha256 !== right.projectionSha256 ||
    !sameVocabStoredLexeme(left.before.lexeme, right.before.lexeme) ||
    !sameVocabStoredLexeme(left.after.lexeme, right.after.lexeme)
  ) return false;
  return left.kind !== "status-set" || right.kind !== "status-set" || (
    sameVocabStoredReviewCard(left.before.reviewCard, right.before.reviewCard) &&
    sameVocabStoredReviewCard(left.after.reviewCard, right.after.reviewCard)
  );
}

function editorOperationMatchesReceipt(
  editor: VocabLexemeNoteEditor,
  receipt: VocabLexemeWriteReceipt,
): boolean {
  const operation = editor.operation;
  return Boolean(operation &&
    sameVocabLexemeWriteReceipt(operation.receipt, receipt));
}

function detachedEditorMatchesReceiptBefore(
  editor: VocabLexemeNoteEditor,
  receipt: VocabLexemeWriteReceipt,
): boolean {
  return !editor.preparation && !editor.operation &&
    editor.lexemeId === receipt.before.lexeme.id &&
    expectedMatchesReceiptSnapshot(editor.expected, receipt, receipt.before);
}

export function beginVocabLexemeEditorPreparation(
  editor: VocabLexemeNoteEditor,
  kind: VocabLexemeWriteReceipt["kind"],
  token: symbol,
): VocabLexemeNoteEditor {
  if (editor.preparation || editor.operation) return editor;
  return {
    ...editor,
    preparation: {
      token,
      kind,
      display: editor.display,
      expected: editor.expected,
      note: editor.note,
      submittedRevision: editor.revision,
    },
  };
}

export function bindVocabLexemeEditorReceipt(
  editor: VocabLexemeNoteEditor,
  token: symbol,
  receipt: VocabLexemeWriteReceipt,
): VocabLexemeNoteEditor {
  const preparation = editor.preparation;
  if (
    !preparation || preparation.token !== token ||
    preparation.kind !== receipt.kind ||
    preparation.display !== editor.display ||
    preparation.expected !== editor.expected ||
    receipt.before.lexeme.id !== editor.lexemeId ||
    !expectedMatchesReceiptSnapshot(
      preparation.expected,
      receipt,
      receipt.before,
    ) ||
    (receipt.kind === "note-save" &&
      receipt.after.lexeme.notes !== preparation.note)
  ) return editor;
  return {
    ...editor,
    preparation: null,
    operation: {
      receipt,
      display: preparation.display,
      expected: preparation.expected,
      note: preparation.note,
      submittedRevision: preparation.submittedRevision,
    },
  };
}

export function cancelVocabLexemeEditorPreparation(
  editor: VocabLexemeNoteEditor,
  token: symbol,
): VocabLexemeNoteEditor {
  return editor.preparation?.token === token
    ? { ...editor, preparation: null }
    : editor;
}

export function discardVocabLexemeEditorOperation(
  editor: VocabLexemeNoteEditor,
  receipt: VocabLexemeWriteReceipt,
): VocabLexemeNoteEditor {
  if (!editorOperationMatchesReceipt(editor, receipt)) return editor;
  const submittedRevision = editor.operation?.submittedRevision ??
    editor.revision;
  return {
    ...editor,
    operation: null,
    forceDirty: editor.forceDirty || (
      editor.revision > submittedRevision && editor.note === editor.baselineNote
    ),
  };
}

export function vocabLexemeEditorNeedsProtection(
  editor: VocabLexemeNoteEditor | null,
): boolean {
  return Boolean(editor && (
    editor.preparation || editor.operation ||
    vocabLexemeNoteEditorDirty(editor)
  ));
}

export function vocabLexemeBundleShouldDefer(
  next: VocabLexemeBindingMap,
  editor: VocabLexemeNoteEditor | null,
  protection: VocabLexemeRefreshProtection | null,
): boolean {
  if (protection && protection.mode !== "any") {
    const protectedBinding = next.get(
      protection.receipt.before.lexeme.id,
    );
    const snapshot = protection.mode === "before-only"
      ? protection.receipt.before
      : protection.receipt.after;
    if (
      !protectedBinding || !expectedMatchesReceiptSnapshot(
        protectedBinding.expected,
        protection.receipt,
        snapshot,
      )
    ) return true;
  }
  if (!editor) return false;
  const binding = next.get(editor.lexemeId);
  const preparation = editor.preparation;
  if (preparation) {
    return !binding || !expectedMatchesPreparation(
      binding.expected,
      preparation,
    );
  }
  const operation = editor.operation;
  if (operation) {
    if (!binding) return true;
    const receipt = operation.receipt;
    if (protection) {
      if (!sameVocabLexemeWriteReceipt(protection.receipt, receipt)) {
        return true;
      }
      if (protection.mode === "any") return false;
      const snapshot = protection.mode === "before-only"
        ? receipt.before
        : receipt.after;
      return !expectedMatchesReceiptSnapshot(
        binding.expected,
        receipt,
        snapshot,
      );
    }
    return !expectedMatchesReceiptSnapshot(
      binding.expected,
      receipt,
      receipt.before,
    ) && !expectedMatchesReceiptSnapshot(
      binding.expected,
      receipt,
      receipt.after,
    );
  }
  if (!vocabLexemeNoteEditorDirty(editor)) return false;
  if (!binding) return true;
  if (
    protection &&
    detachedEditorMatchesReceiptBefore(editor, protection.receipt)
  ) {
    const after = expectedMatchesReceiptSnapshot(
      binding.expected, protection.receipt, protection.receipt.after,
    );
    if (protection.mode === "before-only") {
      return !expectedMatchesReceiptSnapshot(
        binding.expected,
        protection.receipt,
        protection.receipt.before,
      );
    }
    if (protection.mode === "after-only") return !after;
    return false;
  }
  return !sameSimpleReceiptSnapshot(binding.expected, {
    generationId: editor.expected.generationId,
    generationSequence: editor.expected.generationSequence,
    lexeme: editor.expected.lexeme,
  });
}

export function settleVocabLexemeEditor(
  editor: VocabLexemeNoteEditor | null,
  receipt: VocabLexemeWriteReceipt,
  nextBinding: VocabLexemeBinding | null,
): VocabLexemeNoteEditor | null {
  if (!editor || !nextBinding) return editor;
  const ownsOperation = editorOperationMatchesReceipt(editor, receipt);
  const detachedReceipt = detachedEditorMatchesReceiptBefore(editor, receipt);
  if (
    (!ownsOperation && !detachedReceipt) ||
    !expectedMatchesReceiptSnapshot(
      nextBinding.expected, receipt, receipt.after,
    )
  ) return editor;
  const submittedRevision = editor.operation?.submittedRevision ?? 0;
  const hasNewerRevision = ownsOperation &&
    editor.revision > submittedRevision;
  const preserveCurrentNote = detachedReceipt || hasNewerRevision;
  const nextNote = receipt.kind === "note-save" && !preserveCurrentNote
    ? receipt.after.lexeme.notes
    : editor.note;
  return {
    lexemeId: nextBinding.display.id,
    display: nextBinding.display,
    expected: nextBinding.expected,
    baselineNote: nextBinding.display.notes,
    note: nextNote,
    revision: editor.revision,
    forceDirty: detachedReceipt
      ? editor.forceDirty || (
          editor.revision > 0 && nextNote === nextBinding.display.notes
        )
      : hasNewerRevision && nextNote === nextBinding.display.notes,
    preparation: null,
    operation: null,
  };
}

export function settleChangedVocabLexemeEditor(
  editor: VocabLexemeNoteEditor | null,
  receipt: VocabLexemeWriteReceipt,
  nextBinding: VocabLexemeBinding | null,
): VocabLexemeNoteEditor | null {
  if (
    !editor || !nextBinding ||
    (!editorOperationMatchesReceipt(editor, receipt) &&
      !detachedEditorMatchesReceiptBefore(editor, receipt))
  ) return editor;
  const submittedRevision = editor.operation?.submittedRevision ??
    editor.revision;
  return {
    lexemeId: nextBinding.display.id,
    display: nextBinding.display,
    expected: nextBinding.expected,
    baselineNote: nextBinding.display.notes,
    note: editor.note,
    revision: editor.revision,
    forceDirty: editor.forceDirty || (
      editor.revision > submittedRevision &&
      editor.note === nextBinding.display.notes
    ),
    preparation: null,
    operation: null,
  };
}

export function vocabLexemeHeldReceiptBarrier(
  operationId: string | null,
  durableOperationIds: readonly string[],
): Readonly<{ blocksWrites: boolean; volatile: boolean }> {
  if (!operationId) return { blocksWrites: false, volatile: false };
  return {
    blocksWrites: true,
    volatile: !durableOperationIds.includes(operationId),
  };
}

export function vocabLexemeWritePreflightOpen(
  journal: Readonly<{
    loaded: boolean;
    storageUnavailable: boolean;
    lockUnavailable: boolean;
    unreadableCount: number;
    entryCount: number;
  }>,
  externalWriteLocked: boolean,
  hasHeldReceipt: boolean,
): boolean {
  return journal.loaded && !journal.storageUnavailable &&
    !journal.lockUnavailable && journal.unreadableCount === 0 &&
    journal.entryCount === 0 && !externalWriteLocked && !hasHeldReceipt;
}

export function vocabLexemeRatingPreflightOpen(
  externalWriteLocked: boolean,
  journal: Readonly<{
    loaded: boolean;
    storageUnavailable: boolean;
    lockUnavailable: boolean;
    unreadableCount: number;
  }>,
  statusWriteBarrier: boolean,
): boolean {
  return !externalWriteLocked && journal.loaded &&
    !journal.storageUnavailable && !journal.lockUnavailable &&
    journal.unreadableCount === 0 && !statusWriteBarrier;
}

export function vocabLexemeExternalGateOpen(
  externalWriteLocked: boolean,
  externalWriteInProgress: () => boolean,
): boolean {
  if (externalWriteLocked) return false;
  try {
    return !externalWriteInProgress();
  } catch {
    return false;
  }
}

export function vocabLexemeExitDecision(
  volatileOperation: boolean,
  dirtyNote: boolean,
): "leave" | "confirm" | "block" {
  if (volatileOperation) return "block";
  return dirtyNote ? "confirm" : "leave";
}
