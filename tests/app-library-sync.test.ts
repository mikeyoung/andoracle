import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve("src/App.tsx"), "utf8");

const storageEffect = (): string => {
  const start = appSource.indexOf("const storageChanged = (event: StorageEvent)");
  const end = appSource.indexOf("const matchingPatch = userPatches.find", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
};

describe("App cross-tab user-library reconciliation", () => {
  it("never presents a protected newer patch schema as an ordinary empty library", () => {
    const source = storageEffect();

    expect(source).toContain('result.status === "ok" || result.status === "recovered"');
    expect(source).toContain('result.status === "unsupported-version"');
    expect(source).toContain("setActiveUserPatchName(null);");
    expect(source).toContain("setPresetName(matchingPresetName(paramsRef.current));");
    expect(source).toContain("Your current controls were kept; update this app");
  });

  it("stops and unloads stale playback when another tab owns a newer recording schema", () => {
    const source = storageEffect();

    expect(source).toContain("sequenceOperationRef.current += 1;");
    expect(source).toContain("sequencePlayerRef.current?.stop(false);");
    expect(source).toContain("activeSequenceTakeRef.current = null;");
    expect(source).toContain("activeSequenceDataRef.current = null;");
    expect(source).toContain('setSequencePlaybackState("stopped");');
    expect(source).toContain("Playback was stopped; update this app");
  });

  it("cancels a stale patch-library transaction before a URL patch becomes active", () => {
    const navigationStart = appSource.indexOf("const loadPatchFromNavigation");
    const navigationEnd = appSource.indexOf(
      'window.addEventListener("popstate"',
      navigationStart,
    );
    const navigation = appSource.slice(navigationStart, navigationEnd);
    const validPatch = navigation.indexOf('sharedPatch.status === "valid"');
    const closeDialog = navigation.indexOf("setPatchLibraryDialog(null);", validPatch);
    const installParams = navigation.indexOf("paramsRef.current = next;", validPatch);

    expect(validPatch).toBeGreaterThanOrEqual(0);
    expect(closeDialog).toBeGreaterThan(validPatch);
    expect(installParams).toBeGreaterThan(closeDialog);
  });

  it("keeps the active recording playable across canonical cross-tab name migration", () => {
    const playbackStart = appSource.indexOf("const playSequence");
    const playbackEnd = appSource.indexOf("const pauseSequencePlayback", playbackStart);
    expect(playbackStart).toBeGreaterThanOrEqual(0);
    expect(playbackEnd).toBeGreaterThan(playbackStart);

    const playback = appSource.slice(playbackStart, playbackEnd);
    expect(playback).toContain(
      "userSequenceNameKey(candidate.name) === userSequenceNameKey(activeSequenceName)",
    );
  });

  it("stops playback and reports a same-name recording replacement from another tab", () => {
    const replacementStart = appSource.indexOf(
      "if (activeSequenceDataRef.current !== matchingSequence.data)",
    );
    const replacementEnd = appSource.indexOf(
      "if (matchingSequence.name !== activeSequenceName)",
      replacementStart,
    );
    const replacement = appSource.slice(replacementStart, replacementEnd);

    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(replacement).toContain("sequenceOperationRef.current += 1");
    expect(replacement).toContain("sequencePlayerRef.current?.stop(false)");
    expect(replacement).toContain('setSequencePlaybackState("stopped")');
    expect(replacement).toContain("activeSequenceTakeRef.current = decoded");
    expect(replacement).toContain("loaded sequence changed in another tab");
    expect(replacement).toContain("updated recording was loaded");
  });

  it("reports a cross-tab removal while preserving the loaded patch controls", () => {
    const effectStart = appSource.indexOf("if (!activeUserPatchName) return;");
    const changedStart = appSource.indexOf("if (!matchingPatch)", effectStart);
    const changedEnd = appSource.indexOf("if (matchingPatch.name", changedStart);
    const removed = appSource.slice(changedStart, changedEnd);

    expect(changedStart).toBeGreaterThanOrEqual(0);
    expect(removed).toContain("setActiveUserPatchName(null)");
    expect(removed).toContain("setPresetName(matchingPresetName(paramsRef.current))");
    expect(removed).toContain("removed in another tab");
    expect(removed).toContain("current controls were kept as an unsaved patch");
    expect(removed).not.toMatch(/setParams|engine\.setParams|replacePatchUrl/);
  });

  it("protects an in-progress take and flushes controls before an update reload", () => {
    const recordingStart = appSource.indexOf("const toggleSequenceRecording");
    const recordingEnd = appSource.indexOf("const selectSequence", recordingStart);
    const recording = appSource.slice(recordingStart, recordingEnd);
    expect(recording).toContain("if (updateBusyRef.current)");

    const updateStart = appSource.indexOf("const reloadUpdate");
    const updateEnd = appSource.indexOf("const physicalNoteExtremes", updateStart);
    const update = appSource.slice(updateStart, updateEnd);
    const recordingGuard = update.indexOf("sequenceRecorderRef.current?.isRecording");
    const markBusy = update.indexOf("updateBusyRef.current = true;");
    const persist = update.indexOf("persistPatchState(false);");
    const reload = update.indexOf("updateServiceWorker(true)");

    expect(recordingGuard).toBeGreaterThanOrEqual(0);
    expect(markBusy).toBeGreaterThan(recordingGuard);
    expect(persist).toBeGreaterThan(markBusy);
    expect(reload).toBeGreaterThan(persist);
  });

  it("flushes the latest auto-restored patch before opening the native share pipeline", () => {
    const shareStart = appSource.indexOf("const sharePatch = async");
    const shareEnd = appSource.indexOf("const performance = useCallback", shareStart);
    const share = appSource.slice(shareStart, shareEnd);
    const unblockUrl = share.indexOf("urlSyncBlockedRef.current = false;");
    const persist = share.indexOf("persistPatchState(false);", unblockUrl);
    const shareOperation = share.indexOf("patchShareOperationGate.run", persist);

    expect(shareStart).toBeGreaterThanOrEqual(0);
    expect(unblockUrl).toBeGreaterThanOrEqual(0);
    expect(persist).toBeGreaterThan(unblockUrl);
    expect(shareOperation).toBeGreaterThan(persist);
  });

  it("does not encode an unlimited take merely to ask for duplicate-name confirmation", () => {
    const saveStart = appSource.indexOf("const saveSequenceTake");
    const saveEnd = appSource.indexOf("const replaceSequenceTake", saveStart);
    const save = appSource.slice(saveStart, saveEnd);
    const cachedDuplicate = save.indexOf("const existingSequence = normalizedName");
    const duplicateReturn = save.indexOf('status: "duplicate"', cachedDuplicate);
    const lockedSave = save.indexOf("saveUserSequenceSafely", cachedDuplicate);

    expect(cachedDuplicate).toBeGreaterThanOrEqual(0);
    expect(duplicateReturn).toBeGreaterThan(cachedDuplicate);
    expect(lockedSave).toBeGreaterThan(duplicateReturn);
  });
});
