import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dialog source contracts", () => {
  it("places the playable keyboard at the bottom of the synthesizer", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const indicator = source.indexOf('<div className="usage-note">');
    const keyboard = source.indexOf("<Keyboard", indicator);
    const signalPath = source.indexOf('<div className="signal-flow"', indicator);
    const panelGrid = source.indexOf('<div className="panel-grid">', signalPath);
    const midiInput = source.indexOf("<MidiInputControl", panelGrid);
    const mainEnd = source.indexOf("</main>", midiInput);

    expect(indicator).toBeGreaterThanOrEqual(0);
    expect(signalPath).toBeGreaterThan(indicator);
    expect(panelGrid).toBeGreaterThan(signalPath);
    expect(midiInput).toBeGreaterThan(panelGrid);
    expect(keyboard).toBeGreaterThan(midiInput);
    expect(mainEnd).toBeGreaterThan(keyboard);
    expect(source.match(/<Keyboard/g)).toHaveLength(1);
  });

  it("marks every panel containing routed faders for aligned selector spacing", () => {
    const source = readFileSync(resolve("src/components/SynthPanel.tsx"), "utf8");

    expect(source).toContain('item.kind === "route"');
    expect(source).toContain('`control-bank${hasRoutedFaders ? " control-bank--routed" : ""}`');
  });

  it("shows a temporary toast only after the gated clipboard pipeline succeeds", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const pipelineStart = source.indexOf("const performPatchShare = async");
    const pipelineEnd = source.indexOf("const KEYBOARD_MAP", pipelineStart);
    const pipeline = source.slice(pipelineStart, pipelineEnd);
    const shareStart = source.indexOf("const sharePatch = async");
    const shareEnd = source.indexOf("const performance = useCallback", shareStart);
    const share = source.slice(shareStart, shareEnd);
    const clipboardWrite = pipeline.indexOf("await navigator.clipboard.writeText(shareUrl);");
    const clipboardSuccess = pipeline.indexOf('return "copied";', clipboardWrite);
    const nativeShareSuccess = pipeline.indexOf('return "shared";');
    const gatedResult = share.indexOf("await cancellation.race(hostOperation.promise)");
    const clipboardBranch = share.indexOf('if (result === "copied")');
    const toastShown = share.indexOf("showClipboardToast();", clipboardBranch);

    expect(source).toContain("const CLIPBOARD_TOAST_DURATION_MS = 2500;");
    expect(source).toContain("const clipboardToastTimerRef = useRef<number | null>(null);");
    expect(source).toContain('setClipboardToast("Copied to clipboard")');
    expect(source).toContain("}, CLIPBOARD_TOAST_DURATION_MS);");
    expect(share).toContain("clearClipboardToast();");
    expect(clipboardWrite).toBeGreaterThanOrEqual(0);
    expect(clipboardSuccess).toBeGreaterThan(clipboardWrite);
    expect(nativeShareSuccess).toBeGreaterThanOrEqual(0);
    expect(nativeShareSuccess).toBeLessThan(clipboardWrite);
    expect(pipeline).not.toContain("showClipboardToast();");
    expect(gatedResult).toBeGreaterThanOrEqual(0);
    expect(clipboardBranch).toBeGreaterThan(gatedResult);
    expect(toastShown).toBeGreaterThan(clipboardBranch);
    expect(source).toContain('<div className="clipboard-toast" role="status" aria-live="polite" aria-atomic="true">');

    const unmountStart = source.indexOf("mountedRef.current = false;");
    const unmountEnd = source.indexOf("browserOperations.cancelAll();", unmountStart);
    expect(source.slice(unmountStart, unmountEnd)).toContain("window.clearTimeout(clipboardToastTimerRef.current)");
  });

  it("keeps the submitted patch name immutable until its async save settles", () => {
    const source = readFileSync(resolve("src/components/PatchLibraryDialog.tsx"), "utf8");
    const nameFieldStart = source.indexOf('id="patch-library-name"');
    const nameFieldEnd = source.indexOf("onChange=", nameFieldStart);

    expect(nameFieldStart).toBeGreaterThanOrEqual(0);
    expect(nameFieldEnd).toBeGreaterThan(nameFieldStart);
    expect(source.slice(nameFieldStart, nameFieldEnd)).toContain("readOnly={busy}");
  });

  it("propagates cancellable, timeout-bounded authority through both library saves", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const patchDialog = readFileSync(resolve("src/components/PatchLibraryDialog.tsx"), "utf8");
    const sequenceDialog = readFileSync(resolve("src/components/SequenceCommitDialog.tsx"), "utf8");

    expect(patchDialog).toContain("onSave: (");
    expect(patchDialog).toContain("onSave(draftName, saveController!.signal)");
    expect(patchDialog).toContain("LIBRARY_WRITE_TIMEOUT_MS");
    expect(sequenceDialog).toContain("onSave: (");
    expect(sequenceDialog).toContain("onSave(draftName, controller.signal)");
    expect(sequenceDialog).toContain("LIBRARY_WRITE_TIMEOUT_MS");
    expect(app).toContain(
      "saveUserPatchSafely(name, paramsRef.current, undefined, undefined, cancellation.signal)",
    );
    expect(app).toContain(
      "saveUserSequenceSafely(name, take, undefined, undefined, cancellation.signal)",
    );
    expect(app).toMatch(/signal\.aborted && mountedRef\.current[\s\S]*?readUserSequences\(\)/u);
    expect(app).toMatch(/signal\.aborted && mountedRef\.current[\s\S]*?readUserPatches\(\)/u);
    expect(patchDialog).toContain("timed out and may already have completed");
    expect(sequenceDialog).toContain("timed out and may already have completed");
  });

  it("synchronously gates destructive confirmation and releases its async lifecycle", () => {
    const source = readFileSync(resolve("src/components/DeleteConfirmationDialog.tsx"), "utf8");

    expect(source).toContain("onConfirm: (signal: AbortSignal)");
    expect(source).toContain("if (busyRef.current || closeRequestedRef.current) return;");
    expect(source).toContain("busyRef.current = true;");
    expect(source).toContain("active.controller.abort(");
    expect(source).toContain("DELETE_CONFIRMATION_TIMEOUT_MS");
    expect(source).toContain("timed out and may already have completed");
    expect(source).toContain("requestClose();");
    expect(source).toContain("window.clearTimeout(focusTimer);");
    expect(source).toContain("if (busy || cancelFocusRequest === 0) return;");
    expect(source).toContain("Queue focus after React has committed the enabled buttons.");
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('aria-busy={busy}');

    const cancelButtonStart = source.indexOf("ref={cancelButtonRef}");
    const cancelButtonEnd = source.indexOf("</button>", cancelButtonStart);
    expect(source.slice(cancelButtonStart, cancelButtonEnd)).not.toContain("disabled={busy}");

    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const patchDeleteFinally = app.indexOf("authority.signal.aborted && mountedRef.current", app.indexOf("patch-delete"));
    const sequenceDeleteFinally = app.indexOf("authority.signal.aborted && mountedRef.current", app.indexOf("sequence-delete"));
    expect(patchDeleteFinally).toBeGreaterThanOrEqual(0);
    expect(app.slice(patchDeleteFinally, patchDeleteFinally + 300)).toContain("readUserPatches()");
    expect(sequenceDeleteFinally).toBeGreaterThanOrEqual(0);
    const sequenceAbortReconciliation = app.slice(sequenceDeleteFinally, sequenceDeleteFinally + 1_300);
    expect(sequenceAbortReconciliation).toContain("readUserSequences()");
    expect(sequenceAbortReconciliation).toContain("sequencePlayerRef.current?.stop(false)");
    expect(sequenceAbortReconciliation).toContain("setActiveSequenceName(null)");
    expect(sequenceAbortReconciliation.indexOf("setActiveSequenceName(null)"))
      .toBeLessThan(sequenceAbortReconciliation.indexOf("setUserSequences(refreshed.sequences)"));
    expect(sequenceAbortReconciliation).toContain("may already have been deleted");
  });

  it("keeps patch sound/URL intact and fully releases a deleted recording", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const patchDeleteStart = source.indexOf("deleteUserPatchSafely(target.patch");
    const sequenceDeleteStart = source.indexOf("deleteUserSequenceSafely(target.sequence");
    const patchDeleted = source.slice(
      source.indexOf('case "deleted":', patchDeleteStart),
      source.indexOf('case "not-found":', patchDeleteStart),
    );
    const sequenceDeleted = source.slice(
      source.indexOf('case "deleted":', sequenceDeleteStart),
      source.indexOf('case "not-found":', sequenceDeleteStart),
    );

    expect(patchDeleteStart).toBeGreaterThanOrEqual(0);
    expect(patchDeleted).toContain("setUserPatches(result.patches)");
    expect(patchDeleted).toContain("setActiveUserPatchName(null)");
    expect(patchDeleted).not.toMatch(/setParams|engine\.setParams|replacePatchUrl/);
    expect(sequenceDeleteStart).toBeGreaterThan(patchDeleteStart);
    expect(sequenceDeleted).toContain("sequenceOperationRef.current += 1");
    expect(sequenceDeleted).toContain("sequencePlayerRef.current?.stop(false)");
    expect(sequenceDeleted).toContain("activeSequenceTakeRef.current = null");
    expect(sequenceDeleted).toContain("activeSequenceDataRef.current = null");
    expect(sequenceDeleted).toContain('setSequencePlaybackState("stopped")');
    expect(sequenceDeleted).toContain("setActiveSequenceName(null)");
  });

  it("keeps engine power state synchronized when deletion cancels a pending Play", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const playStart = source.indexOf("const playSequence = useCallback(async");
    const powerStarted = source.indexOf("await engine.powerOn(paramsRef.current)", playStart);
    const powerSynchronized = source.indexOf("setPowered(true)", powerStarted);
    const obsoletePlaybackGuard = source.indexOf(
      "if (sequenceOperation !== sequenceOperationRef.current) return;",
      powerStarted,
    );

    expect(playStart).toBeGreaterThanOrEqual(0);
    expect(powerStarted).toBeGreaterThan(playStart);
    expect(powerSynchronized).toBeGreaterThan(powerStarted);
    expect(obsoletePlaybackGuard).toBeGreaterThan(powerSynchronized);
  });

  it("cannot let recording idle-close a pending patch deletion", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const openDeleteStart = source.indexOf("const openActivePatchDeletion");
    const openDeleteEnd = source.indexOf("const openActiveRecordingDeletion", openDeleteStart);
    const openDelete = source.slice(openDeleteStart, openDeleteEnd);
    const patchButtonStart = source.indexOf('aria-label="Delete active user patch"');
    const patchButtonEnd = source.indexOf("</button>", patchButtonStart);
    const patchButton = source.slice(patchButtonStart, patchButtonEnd);

    expect(openDelete).toContain("sequenceRecorderRef.current?.isRecording");
    expect(openDelete).toContain("return;");
    expect(openDelete.indexOf("sequenceRecorderRef.current?.isRecording"))
      .toBeLessThan(openDelete.indexOf("setDeleteConfirmation"));
    expect(patchButton).toContain("disabled={!activeUserPatchName || sequenceRecording}");
  });

  it("orders global, patch, and sequence controls as three deliberate rows", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const utilityRow = source.indexOf('<div className="utility-strip"');
    const patchRow = source.indexOf('<div className="patch-strip"', utilityRow);
    const sequenceRow = source.indexOf("<SequenceTransport", patchRow);
    const utilityMarkup = source.slice(utilityRow, patchRow);

    expect(utilityRow).toBeGreaterThanOrEqual(0);
    expect(patchRow).toBeGreaterThan(utilityRow);
    expect(sequenceRow).toBeGreaterThan(patchRow);
    expect(utilityMarkup).toContain("Panic");
    expect(utilityMarkup).toContain("Help");
    expect(utilityMarkup).toContain("Share Patch");
  });

  it("isolates audio-rate telemetry from the root synthesizer render", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const telemetry = readFileSync(resolve("src/components/OutputMeter.tsx"), "utf8");

    expect(app).not.toContain("engine.onMeter(");
    expect(app).toContain("<EngineTelemetry");
    expect(telemetry).toContain("engine.onMeter((nextMeter) =>");
    expect(telemetry).toContain("export const EngineTelemetry = memo(EngineTelemetryComponent);");
    expect(telemetry).toContain("function LiveEngineTelemetry(");
    expect(telemetry).toMatch(/return running \? \([\s\S]*?<LiveEngineTelemetry[\s\S]*?: \([\s\S]*?<TelemetryReadout[\s\S]*?meter=\{EMPTY_ODYSSEY_METER\}/);
  });

  it("shares one cleaned-up storage listener across both local libraries", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(source.match(/window\.addEventListener\("storage", storageChanged\)/g)).toHaveLength(1);
    expect(source.match(/window\.removeEventListener\("storage", storageChanged\)/g)).toHaveLength(1);
    expect(source).toContain("event.key === null || event.key === USER_PATCHES_STORAGE_KEY");
    expect(source).toContain("event.key === null || event.key === USER_SEQUENCES_STORAGE_KEY");
  });

  it("returns post-delete focus to the playable surface instead of a dropdown", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(source).toContain("const performanceFocusRef = useRef<HTMLElement | null>(null)");
    expect(source).toContain('<main ref={performanceFocusRef} tabIndex={-1}>');
    expect(source).toContain("fallbackOrigin={performanceFocusRef.current}");
  });

  it("invalidates playback before installing a same-name recording replacement", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const replacementStart = source.indexOf(
      "if (activeSequenceDataRef.current !== matchingSequence.data)",
    );
    const replacementEnd = source.indexOf(
      "if (matchingSequence.name !== activeSequenceName)",
      replacementStart,
    );
    const replacement = source.slice(replacementStart, replacementEnd);
    const invalidated = replacement.indexOf("sequenceOperationRef.current += 1");
    const stopped = replacement.indexOf("sequencePlayerRef.current?.stop(false)");
    const decoded = replacement.indexOf("decodeUserSequence(matchingSequence)");
    const installed = replacement.indexOf("activeSequenceTakeRef.current = decoded");

    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(invalidated).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(invalidated);
    expect(decoded).toBeGreaterThan(stopped);
    expect(installed).toBeGreaterThan(decoded);
  });

  it("stops playback before installing an explicitly confirmed recording replacement", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const replacementStart = source.indexOf("const replaceSequenceTake");
    const replacementEnd = source.indexOf("const changeParam", replacementStart);
    const replacement = source.slice(replacementStart, replacementEnd);
    const replacedCase = replacement.indexOf('case "replaced":');
    const invalidated = replacement.indexOf("sequenceOperationRef.current += 1", replacedCase);
    const stopped = replacement.indexOf("sequencePlayerRef.current?.stop(false)", replacedCase);
    const stateStopped = replacement.indexOf('setSequencePlaybackState("stopped")', replacedCase);
    const installed = replacement.indexOf("activeSequenceTakeRef.current = take", replacedCase);
    const closed = replacement.indexOf("setSequenceTake(null)", replacedCase);

    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(replacement).toContain(
      "replaceUserSequenceSafely(expected, take, undefined, undefined, cancellation.signal)",
    );
    expect(invalidated).toBeGreaterThan(replacedCase);
    expect(stopped).toBeGreaterThan(invalidated);
    expect(stateStopped).toBeGreaterThan(stopped);
    expect(installed).toBeGreaterThan(stateStopped);
    expect(closed).toBeGreaterThan(installed);
  });

  it("revokes stale delete authority on patch navigation and active-target replacement", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const revokeStart = source.indexOf("const revokeActiveLibraryDeletion");
    const revokeEnd = source.indexOf("const showSafariInstallHint", revokeStart);
    const revoke = source.slice(revokeStart, revokeEnd);
    const navigationStart = source.indexOf("const loadPatchFromNavigation");
    const navigationEnd = source.indexOf('window.addEventListener("popstate"', navigationStart);
    const navigation = source.slice(navigationStart, navigationEnd);
    const confirmationStart = source.indexOf("const confirmLibraryDeletion");
    const confirmationEnd = source.indexOf("const togglePower", confirmationStart);
    const confirmation = source.slice(confirmationStart, confirmationEnd);

    expect(revoke).toContain("activeDeleteOperationRef.current = null");
    expect(revoke.indexOf("active.controller.abort"))
      .toBeLessThan(revoke.indexOf("setDeleteConfirmation"));
    expect(revoke).toContain("current?.kind === kind");
    expect(navigation).toContain('"patch"');
    expect(confirmation).toContain("activeUserPatchName");
    expect(confirmation).toContain("activeSequenceName");
    expect(confirmation).toContain("The active patch changed after confirmation opened");
    expect(confirmation).toContain("The active recording changed after confirmation opened");
    expect(confirmation).toContain('authority.signal.addEventListener("abort", cancelWhenAborted');
    expect(confirmation).toContain('authority.signal.removeEventListener("abort", cancelWhenAborted)');
    expect(source).toContain("activeDeleteOperationRef.current = operation");
    expect(confirmation).toContain('beginDeleteOperationAuthority("patch", signal)');
    expect(confirmation).toContain('beginDeleteOperationAuthority("recording", signal)');
  });
});
