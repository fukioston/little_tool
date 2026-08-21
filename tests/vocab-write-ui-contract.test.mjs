import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, projectRoot), "utf8");
}

function between(value, start, end) {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return value.slice(from, to);
}

test("import UI synchronously gates writes and separates commit from refresh", async () => {
  const overlay = await source("app/vocab/overlays.tsx");
  assert.match(
    overlay,
    /if \(busyRef\.current\) return false;\s*busyRef\.current = true;\s*setBusy\(true\)/,
  );
  assert.doesNotMatch(overlay, /\bsaveLocalFile\b|\bdeleteLocalFile\b/);
  assert.match(overlay, /saveLocalFileAtKey|saveVocabPodcastWithAudio/);
  assert.match(overlay, /onRecoveryPrepared:[\s\S]*checkpoint\(\{ version: 1, type: "podcast-audio"/);
  assert.match(overlay, /clearCheckpoint\(\);\s*setCommittedId\(id\);\s*setPhase\("refreshing"\)/);
  assert.match(overlay, /内容已经保存，只是页面暂未更新/);
  assert.match(overlay, /"只刷新页面"/);
  assert.match(overlay, /"只读核对"/);
  assert.match(
    overlay,
    /const clearCheckpoint = \(\) => \{[\s\S]*removeImportRecovery\(activeRecovery\.current\)[\s\S]*return activateNextCheckpoint\(\)/,
  );
  const failureRecovery = between(
    overlay,
    "const handleFailure = (caught: unknown, checkpointed: boolean) =>",
    "const submit = async () =>",
  );
  assert.match(
    failureRecovery,
    /VocabPodcastAudioNotSavedError[\s\S]*if \(!clearCheckpoint\(\)\)[\s\S]*setPhase\("idle"\)/,
  );
  assert.match(failureRecovery, /if \(checkpointed\)[\s\S]*setPhase\("uncertain"\)/);
  const checkpointedFailure = between(
    failureRecovery,
    "if (checkpointed) {",
    "if (\n      caught instanceof VocabPodcastAudioConflictError",
  );
  assert.doesNotMatch(
    checkpointedFailure,
    /instanceof VocabWriteUncertainError|instanceof VocabPodcastAudioUncertainError/,
  );
  assert.match(failureRecovery, /数据库和文件都没有改动；可以稍后重新选择后再试/);

  const refreshOnly = between(
    overlay,
    "const refreshOnly = async () =>",
    "const controlsLocked",
  );
  assert.match(refreshOnly, /await onImported\(committedId\)/);
  assert.doesNotMatch(
    refreshOnly,
    /saveArticle|savePodcast|saveVocabPodcastWithAudio|saveFileAtKey/,
  );

  const inspectOnly = between(
    overlay,
    "const inspectRecovery = async () =>",
    "const cleanupRecovery = async () =>",
  );
  assert.match(inspectOnly, /inspectVocabImportWrite/);
  assert.match(inspectOnly, /inspectVocabPodcastAudioWrite/);
  assert.match(
    inspectOnly,
    /status\.database === "exact_saved" &&\s*status\.file === "exact_staged"[\s\S]*clearCheckpoint\(\)/,
  );
  const incompleteAudio = between(
    inspectOnly,
    '} else if (status.database === "exact_saved") {',
    '} else if (\n          status.database === "absent"',
  );
  assert.match(incompleteAudio, /setPhase\(status\.file === "conflict" \? "conflict" : "uncertain"\)/);
  assert.doesNotMatch(incompleteAudio, /clearCheckpoint\(\)/);
  assert.match(
    inspectOnly,
    /status\.database === "absent" &&\s*status\.file !== "unknown"[\s\S]*setPhase\("recovery_absent"\)/,
  );
  assert.match(inspectOnly, /只有底层再次证明它属于这个回执时才会删除/);
  assert.doesNotMatch(
    inspectOnly,
    /saveArticle|savePodcast|saveVocabPodcastWithAudio|deleteOwned|cleanupVocab/,
  );

  const cleanupOnly = between(
    overlay,
    "const cleanupRecovery = async () =>",
    "const abandonConflict = async () =>",
  );
  assert.match(cleanupOnly, /cleanupVocabPodcastAudioWrite\(recovery\.receipt\)/);
  assert.match(cleanupOnly, /底层没有再次证明暂存音频属于这个回执/);
  assert.doesNotMatch(cleanupOnly, /saveArticle|savePodcast|saveVocabPodcastWithAudio/);

  const abandonOnly = between(
    overlay,
    "const abandonConflict = async () =>",
    "const refreshOnly = async () =>",
  );
  assert.doesNotMatch(abandonOnly, /window\.confirm/);
  assert.match(abandonOnly, /removeImportRecovery\(recovery\)/);
  assert.match(abandonOnly, /activateNextCheckpoint\(\)/);
  assert.doesNotMatch(
    abandonOnly,
    /saveArticle|savePodcast|saveVocabPodcastWithAudio|deleteOwned|cleanupVocab|inspectVocab/,
  );
  assert.match(overlay, /const requestAbandonConflict = \(\) =>/);
  assert.match(overlay, /confirmAbandon\?<footer className="sc-reminder-confirm"/);
  assert.match(overlay, /ref=\{keepReminderButton\}[\s\S]*继续保留提醒/);
});

test("word UI uses one atomic receipt and recovery actions never replay save", async () => {
  const app = await source("app/vocab/VocabApp.tsx");
  assert.doesNotMatch(app, /\bsaveOccurrenceNote\b/);
  assert.match(
    app,
    /saveOccurrence\(pending\.target, pending\.explanation, \{\s*note: pending\.note,\s*receipt: pending\.receipt/,
  );
  assert.match(app, /if \(wordSaveBusyRef\.current\) return/);
  assert.match(app, /inspectVocabOccurrenceWrite\(receipt\)/);
  assert.match(app, /"只刷新词库"/);
  assert.match(
    app,
    /if \(\s*wordSaveBusyRef\.current \|\|\s*occurrenceRecoveryRef\.current \|\|\s*committedOccurrenceRef\.current/,
  );
  assert.match(app, /writeOccurrenceRecovery\(pending\.receipt\)[\s\S]*saveOccurrence\(/);
  assert.match(app, /OCCURRENCE_RECOVERY_PREFIX.*vocab\.pending-occurrence-write\.v1:/);
  assert.match(app, /occurrenceRecoveryKey\(receipt\)/);
  assert.match(app, /localStorage\.getItem\(key\) === JSON\.stringify\(receipt\)/);
  const saveFlow = between(
    app,
    "const savePickedWord = useCallback(async (rawNote = \"\") =>",
    "const inspectPendingWord = useCallback(async () =>",
  );
  assert.match(
    saveFlow,
    /caught instanceof VocabWriteNotSavedError[\s\S]*const nextRecovery = activateNextOccurrenceRecovery\(\)[\s\S]*if \(!nextRecovery\)[\s\S]*同一回执安全重试/,
  );

  const inspectOnly = between(
    app,
    "const inspectPendingWord = useCallback(async () =>",
    "const refreshCommittedWord = useCallback(async () =>",
  );
  assert.doesNotMatch(inspectOnly, /saveOccurrence\(/);
  const refreshOnly = between(
    app,
    "const refreshCommittedWord = useCallback(async () =>",
    "const wordPrimaryAction = useCallback",
  );
  assert.match(refreshOnly, /await refresh\(\)/);
  assert.doesNotMatch(refreshOnly, /saveOccurrence\(/);

  const abandonOnly = between(
    app,
    "const abandonConflictedWord = useCallback(async () =>",
    "const wordPrimaryAction = useCallback",
  );
  assert.doesNotMatch(abandonOnly, /window\.confirm/);
  assert.match(abandonOnly, /removeOccurrenceRecovery\(receipt\)/);
  assert.match(abandonOnly, /activateNextOccurrenceRecovery\(\)/);
  assert.doesNotMatch(abandonOnly, /saveOccurrence|inspectVocabOccurrenceWrite/);
  assert.match(app, /const requestAbandonConflictedWord = useCallback/);
  assert.match(app, /data-word-reminder-keep[\s\S]*继续保留提醒/);
  assert.match(app, /confirmReminderRemoval=\{wordAbandonConfirm\}/);
  assert.doesNotMatch(app, /event\.key === "Escape"[\s\S]{0,160}setImportOpen\(false\)/);
  assert.match(app, /data-word-recovery-primary/);
});

test("snapshot refreshes apply only the newest completed read", async () => {
  const app = await source("app/vocab/VocabApp.tsx");
  const sequencedRead = between(
    app,
    "const readVocabFacts = useCallback",
    "const readAndApplySnapshot = useCallback(async () =>",
  );
  assert.match(sequencedRead, /const requestId = \+\+snapshotReadRequestRef\.current/);
  assert.ok(sequencedRead.indexOf("await loadVocabFactsWithSettingsExpected()") < sequencedRead.indexOf("requestId !== snapshotReadRequestRef.current"));
  assert.ok(sequencedRead.indexOf("requestId !== snapshotReadRequestRef.current") < sequencedRead.indexOf("applyVocabFactsBundle(bundle)"));
  const publicRead = between(
    app,
    "const readAndApplySnapshot = useCallback(async () =>",
    "const refresh = useCallback(async () =>",
  );
  assert.match(publicRead, /result\.outcome === "superseded"[\s\S]*?throw new VocabSnapshotSupersededError\(\)/);
  assert.match(app, /if \(!ready\) return;\s*return subscribeVocabChanges/);
  assert.match(
    app,
    /onImported=\{async \(id\) => \{ const data = await readAndApplySnapshot\(\); setImportOpen\(false\)/,
  );
});

test("recovery checkpoints contain identifiers and hashes, not imported prose", async () => {
  const [overlay, store, audio] = await Promise.all([
    source("app/vocab/overlays.tsx"),
    source("lib/vocab/store.ts"),
    source("lib/vocab/write-receipts.ts"),
  ]);
  const importReceipt = between(
    store,
    "export type VocabImportWriteReceipt",
    "export type VocabOccurrenceWriteReceipt",
  );
  assert.match(importReceipt, /operationId: string/);
  assert.match(importReceipt, /contentIds: readonly string\[\]/);
  assert.match(importReceipt, /projectionSha256: string/);
  assert.doesNotMatch(importReceipt, /title|description|text|transcript|blocks|segments/);
  const occurrenceReceipt = between(
    store,
    "export type VocabOccurrenceWriteReceipt",
    "export type VocabWriteReceipt",
  );
  assert.doesNotMatch(occurrenceReceipt, /surface|sentence|context|note|explanation/);
  assert.match(overlay, /IMPORT_RECOVERY_PREFIX.*vocab\.pending-import-write\.v1:/);
  assert.match(overlay, /window\.localStorage\.setItem\(importRecoveryKey\(recovery\), JSON\.stringify\(recovery\)\)/);
  assert.match(overlay, /JSON\.stringify\(current\) === JSON\.stringify\(recovery\)/);
  assert.match(audio, /fileKey: string/);
  assert.match(audio, /stagingOwner: string/);
  assert.match(audio, /fileSha256: string/);
  assert.doesNotMatch(
    between(audio, "export type VocabPodcastAudioWriteReceipt", "export type VocabPodcastAudioFileInspection"),
    /originalName|transcript|segments/,
  );
});

test("AI disclosure copy is sourced from the shared payload contract", async () => {
  const [overlay, app, views] = await Promise.all([
    source("app/vocab/overlays.tsx"),
    source("app/vocab/VocabApp.tsx"),
    source("app/vocab/views.tsx"),
  ]);
  assert.match(overlay, /VOCAB_AI_DISCLOSURE_BY_ACTION\.explain/);
  assert.match(overlay, /VOCAB_AI_DISCLOSURE_BY_ACTION\.explain_chinese/);
  assert.match(overlay, /VOCAB_AI_DISCLOSURE_BY_ACTION\.explain}[\s\S]*minHeight:44[\s\S]*解释这个词/);
  assert.doesNotMatch(overlay, /只发送所选内容与附近句子/);
  const selectText = between(
    app,
    "const selectText = useCallback((target: SelectionTarget) =>",
    "const askAi = useCallback",
  );
  assert.doesNotMatch(selectText, /askAiFor\(/);
  assert.match(views, /只有再点“解释这个词”才会发送/);
  assert.doesNotMatch(views, /AI 只在你主动请求/);
});

test("storage protection is explicit and distinguishes unknown from unsupported", async () => {
  const [app, views] = await Promise.all([
    source("app/vocab/VocabApp.tsx"),
    source("app/vocab/views.tsx"),
  ]);
  const startup = between(
    app,
    "useEffect(() => {\n    let live = true;\n    void (async () =>",
    "useEffect(() => {\n    let live = true;\n    queueMicrotask",
  );
  assert.match(startup, /refreshStorageStatus\(\)/);
  assert.doesNotMatch(startup, /requestPersistentLocalStorage/);
  assert.match(app, /supportsPersistentLocalStorage\(\)/);
  assert.match(app, /const granted = await requestPersistentLocalStorage\(\)/);
  assert.match(app, /checked\.persisted \?\? granted/);
  assert.match(views, /保护状态暂时未知/);
  assert.match(views, /当前浏览器未提供持久化保护接口/);
  assert.match(views, /persistenceSupported&&storage\?\.persisted!==true/);
});
