import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dialog source contracts", () => {
  it("marks every panel containing routed faders for aligned selector spacing", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(source).toContain('section.items.some((item) => item.kind === "route")');
    expect(source).toContain('`control-bank${hasRoutedFaders ? " control-bank--routed" : ""}`');
  });

  it("shows a temporary toast only after a direct clipboard write succeeds", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const shareStart = source.indexOf("const sharePatch = async");
    const shareEnd = source.indexOf("const performance = useCallback", shareStart);
    const share = source.slice(shareStart, shareEnd);
    const clipboardWrite = share.indexOf("await cancellation.race(navigator.clipboard.writeText(shareUrl));");
    const toastShown = share.indexOf("showClipboardToast();", clipboardWrite);
    const nativeShareSuccess = share.indexOf('setNotice("Patch shared.")');

    expect(source).toContain("const CLIPBOARD_TOAST_DURATION_MS = 2500;");
    expect(source).toContain("const clipboardToastTimerRef = useRef<number | null>(null);");
    expect(source).toContain('setClipboardToast("Copied to clipboard")');
    expect(source).toContain("}, CLIPBOARD_TOAST_DURATION_MS);");
    expect(share).toContain("clearClipboardToast();");
    expect(clipboardWrite).toBeGreaterThanOrEqual(0);
    expect(toastShown).toBeGreaterThan(clipboardWrite);
    expect(nativeShareSuccess).toBeGreaterThanOrEqual(0);
    expect(nativeShareSuccess).toBeLessThan(clipboardWrite);
    expect(share.slice(nativeShareSuccess, clipboardWrite)).not.toContain("showClipboardToast();");
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

  it("synchronously gates destructive confirmation and releases its async lifecycle", () => {
    const source = readFileSync(resolve("src/components/DeleteConfirmationDialog.tsx"), "utf8");

    expect(source).toContain("onConfirm: (signal: AbortSignal)");
    expect(source).toContain("if (busyRef.current || closeRequestedRef.current) return;");
    expect(source).toContain("busyRef.current = true;");
    expect(source).toContain("active.controller.abort(");
    expect(source).toContain("DELETE_CONFIRMATION_TIMEOUT_MS");
    expect(source).toContain("requestClose();");
    expect(source).toContain("window.clearTimeout(focusTimer);");
    expect(source).toContain("if (busy || cancelFocusRequest === 0) return;");
    expect(source).toContain("Queue focus after React has committed the enabled buttons.");
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('aria-busy={busy}');

    const cancelButtonStart = source.indexOf("ref={cancelButtonRef}");
    const cancelButtonEnd = source.indexOf("</button>", cancelButtonStart);
    expect(source.slice(cancelButtonStart, cancelButtonEnd)).not.toContain("disabled={busy}");
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
    const playStart = source.indexOf("const playSequence = async");
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
      "replaceUserSequenceSafely(expected, take, undefined, undefined, signal)",
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
