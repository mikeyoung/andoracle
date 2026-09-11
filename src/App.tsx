import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import keepAliveAudioUrl from "./assets/audio-keepalive.wav?inline";
import { OdysseyAudioEngine, type AudioEngineStatus } from "./audio/engine";
import { AudioKeepAliveController } from "./audio/keepalive";
import type { PerformanceState } from "./audio/dsp-core";
import { DirectEntryModal } from "./components/DirectEntryModal";
import { DeleteConfirmationDialog } from "./components/DeleteConfirmationDialog";
import { HelpDialog } from "./components/HelpDialog";
import { Keyboard, type KeyboardPosition } from "./components/Keyboard";
import {
  MidiInputControl,
  midiInputListLabel,
  type MidiInputOperation,
} from "./components/MidiInputControl";
import { LiveOutputMeter } from "./components/OutputMeter";
import {
  PatchLibraryDialog,
  type PatchLibraryMode,
  type PatchSaveOutcome,
} from "./components/PatchLibraryDialog";
import { PatchSelector } from "./components/PatchSelector";
import {
  SequenceCommitDialog,
  type SequenceSaveOutcome,
} from "./components/SequenceCommitDialog";
import { SequenceTransport, type SequencePlaybackState } from "./components/SequenceTransport";
import { SynthPanel } from "./components/SynthPanel";
import { RasterLabel } from "./components/RasterLabel";
import { OperationCancellationRegistry } from "./cancellable-operation";
import { blocksComputerKeyboardNotes, reservesComputerKeyboardChord } from "./computer-keyboard";
import { ExclusiveOperationGuard } from "./exclusive-operation-guard";
import {
  HOST_OPERATION_UI_TIMEOUT_MS,
  KeyedHostOperationGate,
  createHostOperationDeadline,
} from "./host-operation";
import {
  NoteOwnershipIndex,
  findNoteExtremes,
  noteSetsMatch,
} from "./note-ownership";
import {
  WebMidiSession,
  combinePerformanceSources,
  getWebMidiAvailability,
  type WebMidiHandlers,
  type MidiInputSummary,
  type MidiPerformanceSources,
} from "./midi/web-midi";
import { recoverAfterMidiAllSoundOff } from "./midi/audio-integration";
import { usePwaRegistration } from "./pwa/use-pwa-registration";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
  normalizeParamValue,
  normalizePatch,
  type ParamKey,
  type SynthParams,
} from "./synth/params";
import { readPatchFromUrl, urlWithPatch } from "./synth/patch-url";
import { FACTORY_PRESETS } from "./synth/presets";
import {
  USER_PATCHES_STORAGE_KEY,
  deleteUserPatchSafely,
  normalizeUserPatchName,
  readUserPatches,
  replaceUserPatchSafely,
  saveUserPatchSafely,
  uniqueUserPatchMatchingParams,
  userPatchNameKey,
  type UserPatch,
} from "./synth/user-patches";
import {
  USER_SEQUENCES_STORAGE_KEY,
  decodeUserSequence,
  deleteUserSequenceSafely,
  normalizeUserSequenceName,
  readUserSequences,
  replaceUserSequenceSafely,
  saveUserSequenceSafely,
  userSequenceNameKey,
  type CapturedNoteSequence,
  type UserNoteSequence,
} from "./sequencer/user-sequences";
import {
  NoteSequencePlayer,
  NoteSequenceRecorder,
  SEQUENCE_SOURCE_PREFIX,
} from "./sequencer/transport";
import { PANEL_SECTIONS } from "./ui/layout";

// Keep the pre-Andoracle key so existing users retain their last patch after the rename.
const PATCH_STORAGE_KEY = "arpy-odyssey:last-patch:v1";
const KEYBOARD_POSITION_STORAGE_KEY = "andoracle:keyboard-position:v1";
const CLIPBOARD_TOAST_DURATION_MS = 2500;
const NOOP_MIDI_HANDLERS: WebMidiHandlers = {
  noteOn: () => undefined,
  noteOff: () => undefined,
  pitchBend: () => undefined,
  modulation: () => undefined,
  allSoundOff: () => undefined,
  inputsChanged: () => undefined,
  error: () => undefined,
};
const RESERVED_PATCH_NAMES = new Set([
  userPatchNameKey("Custom patch"),
  ...FACTORY_PRESETS.map((preset) => userPatchNameKey(preset.name)),
]);

const readKeyboardPosition = (): KeyboardPosition => {
  try {
    return window.localStorage.getItem(KEYBOARD_POSITION_STORAGE_KEY) === "top" ? "top" : "bottom";
  } catch {
    return "bottom";
  }
};

type PatchShareResult = "shared" | "copied";

const midiReadyNotice = (inputs: readonly MidiInputSummary[]): string => (
  inputs.length > 0
    ? `MIDI ready: ${midiInputListLabel(inputs)}.`
    : "MIDI access enabled. Connect or switch on a keyboard; it will be detected automatically."
);

// Web Share and clipboard promises are browser-owned and cannot be aborted.
// Keep one page-lifetime pipeline so a released UI wait cannot let retries
// stack native operations or accidentally share a different patch URL.
const patchShareOperationGate = new KeyedHostOperationGate<string, PatchShareResult>();

const performPatchShare = async (shareUrl: string): Promise<PatchShareResult> => {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: "Andoracle synthesizer patch",
        text: "Playable patch for the Andoracle ARP Odyssey-inspired duophonic browser synthesizer.",
        url: shareUrl,
      });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
    }
  }

  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(shareUrl);
  return "copied";
};

const KEYBOARD_MAP: Readonly<Record<string, number>> = {
  KeyA: 48,
  KeyW: 49,
  KeyS: 50,
  KeyE: 51,
  KeyD: 52,
  KeyF: 53,
  KeyT: 54,
  KeyG: 55,
  KeyY: 56,
  KeyH: 57,
  KeyU: 58,
  KeyJ: 59,
  KeyK: 60,
  KeyO: 61,
  KeyL: 62,
  KeyP: 63,
  Semicolon: 64,
};

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const loadStoredPatch = (): SynthParams => {
  try {
    const stored = window.localStorage.getItem(PATCH_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PARAMS };
    return normalizePatch(JSON.parse(stored) as Partial<SynthParams>);
  } catch {
    return { ...DEFAULT_PARAMS };
  }
};

interface InitialPatchState {
  readonly params: SynthParams;
  readonly notice: string;
  readonly preserveUnsupportedUrl: boolean;
}

const matchingPresetName = (params: SynthParams): string => (
  FACTORY_PRESETS.find((preset) => (
    PARAM_KEYS.every((key) => Object.is(preset.params[key], params[key]))
  ))?.name ?? "Custom patch"
);

const loadInitialPatch = (): InitialPatchState => {
  const sharedPatch = readPatchFromUrl(window.location.href);
  if (sharedPatch.status === "valid") {
    return {
      params: sharedPatch.params,
      notice: "Shared patch loaded from this URL. Press POWER to authorize audio.",
      preserveUnsupportedUrl: false,
    };
  }

  const storedPatch = loadStoredPatch();
  if (sharedPatch.status === "unsupported") {
    return {
      params: storedPatch,
      notice: "This patch link was created by a newer Andoracle version. Update the app to open it.",
      preserveUnsupportedUrl: true,
    };
  }
  if (sharedPatch.status === "invalid") {
    return {
      params: storedPatch,
      notice: "That shared patch link is invalid. Your saved patch was restored.",
      preserveUnsupportedUrl: false,
    };
  }
  return {
    params: storedPatch,
    notice: "Ready. Press POWER to authorize audio.",
    preserveUnsupportedUrl: false,
  };
};

const replacePatchUrl = (params: SynthParams): void => {
  const nextUrl = urlWithPatch(window.location.href, params);
  if (nextUrl !== window.location.href) {
    window.history.replaceState(window.history.state, "", nextUrl);
  }
};

type DeleteConfirmationTarget =
  | {
      readonly kind: "patch";
      readonly patch: UserPatch;
      readonly origin: HTMLButtonElement;
    }
  | {
      readonly kind: "recording";
      readonly sequence: UserNoteSequence;
      readonly origin: HTMLButtonElement;
    };

interface ActiveDeleteOperation {
  readonly kind: DeleteConfirmationTarget["kind"];
  readonly controller: AbortController;
}

function App() {
  const initialPatchRef = useRef<InitialPatchState | null>(null);
  const initialPatch = initialPatchRef.current ?? loadInitialPatch();
  initialPatchRef.current = initialPatch;
  const initialUserPatchesRef = useRef<readonly UserPatch[] | null>(null);
  initialUserPatchesRef.current ??= readUserPatches().patches;
  const engineRef = useRef<OdysseyAudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new OdysseyAudioEngine();
  const engine = engineRef.current;
  const [params, setParams] = useState<SynthParams>(initialPatch.params);
  const paramsRef = useRef(params);
  const [keyboardPosition, setKeyboardPosition] = useState<KeyboardPosition>(readKeyboardPosition);
  const [powered, setPowered] = useState(false);
  const poweredRef = useRef(powered);
  poweredRef.current = powered;
  const audioKeepAliveRef = useRef<AudioKeepAliveController | null>(null);
  const ensureAudioReadyRef = useRef<() => void | Promise<void>>(() => undefined);
  const [powerBusy, setPowerBusy] = useState(false);
  const [externalInputEnabled, setExternalInputEnabled] = useState(false);
  const externalInputEnabledRef = useRef(false);
  const [externalInputBusy, setExternalInputBusy] = useState(false);
  const [externalInputError, setExternalInputError] = useState<string | null>(null);
  const midiAvailability = useMemo(getWebMidiAvailability, []);
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [midiOperation, setMidiOperation] = useState<MidiInputOperation>(null);
  const [midiError, setMidiError] = useState<string | null>(null);
  const midiErrorRef = useRef<string | null>(null);
  const [midiInputs, setMidiInputs] = useState<readonly MidiInputSummary[]>([]);
  const [presetName, setPresetName] = useState(() => matchingPresetName(initialPatch.params));
  const [activeUserPatchName, setActiveUserPatchName] = useState<string | null>(() => (
    matchingPresetName(initialPatch.params) === "Custom patch"
      ? uniqueUserPatchMatchingParams(initialUserPatchesRef.current ?? [], initialPatch.params)?.name ?? null
      : null
  ));
  const [audioStatus, setAudioStatus] = useState<AudioEngineStatus>({
    state: "uninitialized",
    requestedSampleRate: 44100,
    actualSampleRate: null,
    error: null,
  });
  const [activeNotes, setActiveNotes] = useState<ReadonlySet<number>>(new Set());
  const [inputResetEpoch, setInputResetEpoch] = useState(0);
  const noteSources = useRef(new Map<string, number>());
  const noteOwnerCounts = useRef(new NoteOwnershipIndex());
  const sequenceRecorderRef = useRef<NoteSequenceRecorder | null>(null);
  const sequencePlayerRef = useRef<NoteSequencePlayer | null>(null);
  const sequenceLifecyclePausedRef = useRef(false);
  const finishRecordingRef = useRef<(reason: "manual" | "idle") => void>(() => undefined);
  const sequenceOperationRef = useRef(0);
  const activeSequenceTakeRef = useRef<CapturedNoteSequence | null>(null);
  const activeSequenceDataRef = useRef<string | null>(null);
  const recordButtonRef = useRef<HTMLButtonElement | null>(null);
  const performanceFocusRef = useRef<HTMLElement | null>(null);
  const midiSessionRef = useRef<WebMidiSession | null>(null);
  const mountedRef = useRef(true);
  const powerOperationRef = useRef(0);
  const externalInputOperationRef = useRef(0);
  const externalInputStartedPowerRef = useRef(false);
  const externalInputCancellationGuardRef = useRef<ExclusiveOperationGuard | null>(null);
  externalInputCancellationGuardRef.current ??= new ExclusiveOperationGuard();
  const externalInputCancellationGuard = externalInputCancellationGuardRef.current;
  const midiOperationRef = useRef(0);
  const midiCancellationGuardRef = useRef<ExclusiveOperationGuard | null>(null);
  midiCancellationGuardRef.current ??= new ExclusiveOperationGuard();
  const midiCancellationGuard = midiCancellationGuardRef.current;
  const shareBusyRef = useRef(false);
  const clipboardToastTimerRef = useRef<number | null>(null);
  const updateBusyRef = useRef(false);
  const activeDeleteOperationRef = useRef<ActiveDeleteOperation | null>(null);
  const browserOperationsRef = useRef<OperationCancellationRegistry | null>(null);
  if (!browserOperationsRef.current) browserOperationsRef.current = new OperationCancellationRegistry();
  const browserOperations = browserOperationsRef.current;
  const urlSyncTimerRef = useRef<number | null>(null);
  const urlSyncStartedRef = useRef(false);
  const urlSyncBlockedRef = useRef(initialPatch.preserveUnsupportedUrl);
  const urlSyncFailureNotifiedRef = useRef(false);
  const lastHandledPatchHrefRef = useRef(window.location.href);
  const performanceSources = useRef<MidiPerformanceSources>({
    ppcBendSemitones: 0,
    ppcVibratoSemitones: 0,
    midiBendNormalized: 0,
    midiModNormalized: 0,
  });
  const [directEditor, setDirectEditor] = useState<{
    param: ParamKey;
    origin: HTMLElement | null;
    displayScale: number;
    restoreOriginFocus: boolean;
  } | null>(null);
  const [userPatches, setUserPatches] = useState<readonly UserPatch[]>(() => (
    initialUserPatchesRef.current ?? []
  ));
  const patchNames = useMemo(
    () => userPatches.map((patch) => patch.name),
    [userPatches],
  );
  const [userSequences, setUserSequences] = useState<readonly UserNoteSequence[]>(() => readUserSequences().sequences);
  const sequenceNames = useMemo(
    () => userSequences.map((sequence) => sequence.name),
    [userSequences],
  );
  const [activeSequenceName, setActiveSequenceName] = useState<string | null>(null);
  const [sequenceRecording, setSequenceRecording] = useState(false);
  const [sequencePlaybackState, setSequencePlaybackState] = useState<SequencePlaybackState>("stopped");
  const [sequenceTake, setSequenceTake] = useState<{
    take: CapturedNoteSequence;
    origin: HTMLElement | null;
  } | null>(null);
  const [patchLibraryDialog, setPatchLibraryDialog] = useState<{
    mode: PatchLibraryMode;
    origin: HTMLElement | null;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationTarget | null>(null);
  const [helpDialogOrigin, setHelpDialogOrigin] = useState<HTMLElement | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [clipboardToast, setClipboardToast] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [notice, setNotice] = useState(initialPatch.notice);
  const revokeActiveLibraryDeletion = useCallback((
    message: string,
    kind?: DeleteConfirmationTarget["kind"],
  ): void => {
    const active = activeDeleteOperationRef.current;
    if (!kind || active?.kind === kind) {
      activeDeleteOperationRef.current = null;
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new DOMException(message, "AbortError"));
      }
    }
    setDeleteConfirmation((current) => (
      !kind || current?.kind === kind ? null : current
    ));
  }, []);
  const {
    offlineReady,
    needRefresh,
    error: pwaRegistrationError,
    setOfflineReady,
    setNeedRefresh,
    clearError: clearPwaRegistrationError,
    updateServiceWorker,
  } = usePwaRegistration();

  useEffect(() => {
    if (pwaRegistrationError === null) return;
    setNotice(`Offline setup failed: ${pwaRegistrationError instanceof Error ? pwaRegistrationError.message : String(pwaRegistrationError)}`);
    clearPwaRegistrationError();
  }, [clearPwaRegistrationError, pwaRegistrationError]);

  const persistPatchState = useCallback((notifyFailure: boolean): void => {
    if (urlSyncTimerRef.current !== null) window.clearTimeout(urlSyncTimerRef.current);
    urlSyncTimerRef.current = null;
    try {
      window.localStorage.setItem(PATCH_STORAGE_KEY, JSON.stringify(paramsRef.current));
    } catch {
      if (notifyFailure) {
        setNotice("This browser is blocking patch storage; the synth still works, but edits will not persist.");
      }
    }

    if (urlSyncBlockedRef.current) return;
    if (window.location.href !== lastHandledPatchHrefRef.current) return;
    try {
      replacePatchUrl(paramsRef.current);
      lastHandledPatchHrefRef.current = window.location.href;
      urlSyncFailureNotifiedRef.current = false;
    } catch {
      if (notifyFailure && !urlSyncFailureNotifiedRef.current) {
        urlSyncFailureNotifiedRef.current = true;
        setNotice("The patch is working, but this browser would not update its shareable URL.");
      }
    }
  }, []);

  useEffect(() => {
    paramsRef.current = params;

    if (!urlSyncStartedRef.current) {
      urlSyncStartedRef.current = true;
      persistPatchState(true);
      return;
    }

    if (urlSyncTimerRef.current !== null) window.clearTimeout(urlSyncTimerRef.current);
    // localStorage is synchronous. Sharing one trailing timer with URL updates
    // prevents a touch-drag from blocking the main thread on every dial event.
    urlSyncTimerRef.current = window.setTimeout(() => persistPatchState(true), 120);
    return () => {
      if (urlSyncTimerRef.current !== null) window.clearTimeout(urlSyncTimerRef.current);
      urlSyncTimerRef.current = null;
    };
  }, [params, persistPatchState]);

  useEffect(() => {
    const flushPatchUrl = (): void => {
      persistPatchState(false);
    };
    const flushWhenHidden = (): void => {
      if (document.hidden) flushPatchUrl();
    };
    const flushAfterParameterCommit = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-param]")) flushPatchUrl();
    };
    window.addEventListener("blur", flushPatchUrl);
    window.addEventListener("beforeunload", flushPatchUrl);
    window.addEventListener("change", flushAfterParameterCommit);
    window.addEventListener("keyup", flushAfterParameterCommit);
    window.addEventListener("pagehide", flushPatchUrl);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("blur", flushPatchUrl);
      window.removeEventListener("beforeunload", flushPatchUrl);
      window.removeEventListener("change", flushAfterParameterCommit);
      window.removeEventListener("keyup", flushAfterParameterCommit);
      window.removeEventListener("pagehide", flushPatchUrl);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [persistPatchState]);

  useEffect(() => {
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === null || event.key === USER_PATCHES_STORAGE_KEY) {
        const result = readUserPatches();
        if (result.status === "ok" || result.status === "recovered") {
          setUserPatches(result.patches);
        } else if (result.status === "unsupported-version") {
          // A newer tab owns this library now. Do not let the ordinary
          // missing-active-patch effect misreport a protected schema as a
          // deletion, and do not leave stale entries selectable.
          revokeActiveLibraryDeletion(
            "A newer patch library replaced the deletion target.",
            "patch",
          );
          setPatchLibraryDialog(null);
          setActiveUserPatchName(null);
          setPresetName(matchingPresetName(paramsRef.current));
          setUserPatches([]);
          setNotice("A newer Andoracle version updated the patch library. Your current controls were kept; update this app to access that library.");
        }
      }
      if (event.key === null || event.key === USER_SEQUENCES_STORAGE_KEY) {
        const result = readUserSequences();
        if (result.status === "ok" || result.status === "recovered") {
          setUserSequences(result.sequences);
        } else if (result.status === "unsupported-version") {
          revokeActiveLibraryDeletion(
            "A newer recording library replaced the deletion target.",
            "recording",
          );
          sequenceOperationRef.current += 1;
          sequencePlayerRef.current?.stop(false);
          activeSequenceTakeRef.current = null;
          activeSequenceDataRef.current = null;
          setSequencePlaybackState("stopped");
          setActiveSequenceName(null);
          setUserSequences([]);
          setNotice("A newer Andoracle version updated the recording library. Playback was stopped; update this app to access that library.");
        }
      }
    };
    window.addEventListener("storage", storageChanged);
    return () => window.removeEventListener("storage", storageChanged);
  }, [revokeActiveLibraryDeletion]);

  useEffect(() => {
    if (!activeUserPatchName) return;
    const matchingPatch = userPatches.find(
      (patch) => userPatchNameKey(patch.name) === userPatchNameKey(activeUserPatchName),
    );
    if (!matchingPatch) {
      revokeActiveLibraryDeletion(
        "The active patch was removed while deletion was pending.",
        "patch",
      );
      setActiveUserPatchName(null);
      setPresetName(matchingPresetName(paramsRef.current));
      setNotice((current) => current.startsWith("Patch deletion cancellation was requested")
        ? current
        : "The loaded user patch was removed in another tab. Your current controls were kept as an unsaved patch.");
      return;
    }
    if (matchingPatch.name !== activeUserPatchName) setActiveUserPatchName(matchingPatch.name);
    if (PARAM_KEYS.every((key) => Object.is(matchingPatch.params[key], paramsRef.current[key]))) return;
    revokeActiveLibraryDeletion(
      "The active patch changed while deletion was pending.",
      "patch",
    );
    setActiveUserPatchName(null);
    setPresetName(matchingPresetName(paramsRef.current));
    setNotice("The loaded user patch changed in another tab. Your current controls were kept as an unsaved patch.");
  }, [activeUserPatchName, revokeActiveLibraryDeletion, userPatches]);

  useEffect(() => {
    if (!activeSequenceName) return;
    const matchingSequence = userSequences.find(
      (sequence) => userSequenceNameKey(sequence.name) === userSequenceNameKey(activeSequenceName),
    );
    if (matchingSequence) {
      if (activeSequenceDataRef.current !== matchingSequence.data) {
        revokeActiveLibraryDeletion(
          "The active recording changed while deletion was pending.",
          "recording",
        );
        // Replacing a same-name recording invalidates both active playback and
        // a Play request that may still be waiting for AudioContext startup.
        sequenceOperationRef.current += 1;
        sequencePlayerRef.current?.stop(false);
        setSequencePlaybackState("stopped");
        const decoded = decodeUserSequence(matchingSequence);
        if (!decoded) {
          activeSequenceTakeRef.current = null;
          activeSequenceDataRef.current = null;
          setActiveSequenceName(null);
          setNotice("The loaded sequence is damaged and was unloaded.");
          return;
        }
        activeSequenceTakeRef.current = decoded;
        activeSequenceDataRef.current = matchingSequence.data;
        setNotice((current) => current.startsWith("That recording changed after confirmation opened")
          ? current
          : "The loaded sequence changed in another tab. Playback was stopped and the updated recording was loaded.");
      }
      if (matchingSequence.name !== activeSequenceName) setActiveSequenceName(matchingSequence.name);
      return;
    }
    revokeActiveLibraryDeletion(
      "The active recording was removed while deletion was pending.",
      "recording",
    );
    sequenceOperationRef.current += 1;
    sequencePlayerRef.current?.stop(false);
    activeSequenceTakeRef.current = null;
    activeSequenceDataRef.current = null;
    setSequencePlaybackState("stopped");
    setActiveSequenceName(null);
    setNotice("The loaded sequence was removed in another tab.");
  }, [activeSequenceName, revokeActiveLibraryDeletion, userSequences]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeStatus = engine.onStatus((status) => {
      if (!mountedRef.current) return;
      setAudioStatus(status);
      if (status.state === "running") {
        if (engine.isPowerRequested) setPowered(true);
        else {
          audioKeepAliveRef.current?.disable();
          setPowered(false);
        }
        return;
      }
      if (engine.isPowerRequested) {
        if (poweredRef.current) audioKeepAliveRef.current?.notifyAudioInterruption();
        return;
      }
      if (sequencePlayerRef.current?.isActive) {
        sequenceOperationRef.current += 1;
        sequencePlayerRef.current.stop(false);
        setSequencePlaybackState("stopped");
      }
      audioKeepAliveRef.current?.disable();
      setPowered(false);
    });
    const unsubscribeExternalInput = engine.onExternalInputState((connected) => {
      externalInputEnabledRef.current = connected;
      audioKeepAliveRef.current?.setCaptureActive(connected);
      if (mountedRef.current) setExternalInputEnabled(connected);
    });
    return () => {
      mountedRef.current = false;
      sequenceOperationRef.current += 1;
      sequenceRecorderRef.current?.dispose();
      sequencePlayerRef.current?.dispose();
      activeSequenceTakeRef.current = null;
      activeSequenceDataRef.current = null;
      powerOperationRef.current += 1;
      externalInputOperationRef.current += 1;
      externalInputStartedPowerRef.current = false;
      externalInputCancellationGuard.invalidate();
      midiOperationRef.current += 1;
      midiCancellationGuard.invalidate();
      externalInputEnabledRef.current = false;
      shareBusyRef.current = false;
      if (clipboardToastTimerRef.current !== null) {
        window.clearTimeout(clipboardToastTimerRef.current);
        clipboardToastTimerRef.current = null;
      }
      updateBusyRef.current = false;
      const deleteOperation = activeDeleteOperationRef.current;
      activeDeleteOperationRef.current = null;
      deleteOperation?.controller.abort(
        new DOMException("Andoracle closed during deletion.", "AbortError"),
      );
      browserOperations.cancelAll();
      engine.disableExternalInput();
      engine.allNotesOff();
      engine.setPerformance({ bendSemitones: 0, vibratoSemitones: 0 });
      void midiSessionRef.current?.disconnect(true).catch(() => undefined);
      unsubscribeStatus();
      unsubscribeExternalInput();
      queueMicrotask(() => {
        // React StrictMode immediately replays effects in development. Dispose
        // only if this App instance remained unmounted after that replay.
        if (mountedRef.current) return;
        void engine.dispose().catch(() => undefined);
        void midiSessionRef.current?.dispose().catch(() => undefined);
      });
    };
  }, [engine, externalInputCancellationGuard, midiCancellationGuard]);

  useEffect(() => {
    const beforeInstall = (event: Event): void => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const installed = (): void => {
      setInstallPrompt(null);
      setNotice("Andoracle is installed and available from your app launcher.");
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  const syncActiveNotes = useCallback((): void => {
    if (!mountedRef.current) return;
    const nextNotes = new Set(noteSources.current.values());
    setActiveNotes((currentNotes) => (
      noteSetsMatch(currentNotes, nextNotes) ? currentNotes : nextNotes
    ));
  }, []);

  const syncPerformance = useCallback((settings: SynthParams = paramsRef.current): void => {
    engine.setPerformance(combinePerformanceSources(
      performanceSources.current,
      settings.ppcBendRange,
      settings.ppcVibratoRange,
    ));
    // Hardware wheels can be the first activity after a host suspension and
    // do not generate a browser pointer/key gesture. Recover immediately
    // instead of waiting for the periodic keepalive watchdog.
    if (poweredRef.current && !engine.isAudioReady) {
      audioKeepAliveRef.current?.notifyAudioInterruption();
    }
  }, [engine]);

  ensureAudioReadyRef.current = async (): Promise<void> => {
    if (!mountedRef.current || !poweredRef.current) return;
    const result = await engine.ensureRunning();
    if (
      !mountedRef.current
      || !poweredRef.current
      || result === "off"
      || result === "already-running"
    ) return;

    // powerOn deliberately clears the worklet's note ownership. Rehydrate
    // whatever UI, MIDI, AUTO, or sequence sources are logically held now,
    // not the possibly stale set from when the interruption began.
    engine.setParams(paramsRef.current);
    for (const note of new Set(noteSources.current.values())) engine.noteOn(note);
    syncPerformance();
  };

  useEffect(() => {
    let keepAlive: AudioKeepAliveController;
    try {
      keepAlive = new AudioKeepAliveController({
        sourceUrl: keepAliveAudioUrl,
        isAudioReady: () => engine.isAudioReady,
        ensureAudioReady: () => ensureAudioReadyRef.current(),
      });
    } catch {
      // Keep Web Audio usable even in a host that omits HTML media support.
      return;
    }
    audioKeepAliveRef.current = keepAlive;
    if (poweredRef.current) keepAlive.enableFromUserGesture();
    return () => {
      if (audioKeepAliveRef.current === keepAlive) audioKeepAliveRef.current = null;
      keepAlive.dispose();
    };
  }, []);

  const updateMidiError = useCallback((message: string | null): void => {
    midiErrorRef.current = message;
    setMidiError(message);
  }, []);

  useEffect(() => {
    const loadPatchFromNavigation = (): void => {
      const href = window.location.href;
      if (lastHandledPatchHrefRef.current === href) return;
      lastHandledPatchHrefRef.current = href;
      // Back/Forward may run while a native modal is open. A confirmation
      // captured for the former active patch must not survive navigation.
      revokeActiveLibraryDeletion(
        "Patch navigation changed the active deletion target.",
        "patch",
      );

      if (urlSyncTimerRef.current !== null) window.clearTimeout(urlSyncTimerRef.current);
      urlSyncTimerRef.current = null;
      const sharedPatch = readPatchFromUrl(href);

      if (sharedPatch.status === "unsupported") {
        urlSyncBlockedRef.current = true;
        setNotice("This patch link was created by a newer Andoracle version. Update the app to open it.");
        return;
      }

      urlSyncBlockedRef.current = false;
      if (sharedPatch.status === "valid") {
        const next = sharedPatch.params;
        const nextPresetName = matchingPresetName(next);
        const matchingUserPatch = nextPresetName === "Custom patch"
          ? uniqueUserPatchMatchingParams(userPatches, next)
          : null;
        // A patch save/replace operation snapshots the controls that were
        // visible when it began. Navigating to a different patch invalidates
        // that dialog's context; unmount it so its AbortSignal revokes any
        // deferred cross-tab write before the new URL state becomes active.
        setPatchLibraryDialog(null);
        paramsRef.current = next;
        setParams(next);
        setActiveUserPatchName(matchingUserPatch?.name ?? null);
        setPresetName(nextPresetName);
        setDirectEditor(null);
        engine.setParams(next);
        syncPerformance(next);
        setNotice("Shared patch loaded from the URL. Audio power and hardware connections were left unchanged.");
        return;
      }

      try {
        replacePatchUrl(paramsRef.current);
        lastHandledPatchHrefRef.current = window.location.href;
        setNotice(sharedPatch.status === "invalid"
          ? "That shared patch link is invalid. The current patch was kept."
          : "The current patch has been restored to the URL.");
      } catch {
        setNotice("The current patch is intact, but this browser would not restore its shareable URL.");
      }
    };

    window.addEventListener("popstate", loadPatchFromNavigation);
    window.addEventListener("hashchange", loadPatchFromNavigation);
    return () => {
      window.removeEventListener("popstate", loadPatchFromNavigation);
      window.removeEventListener("hashchange", loadPatchFromNavigation);
    };
  }, [engine, revokeActiveLibraryDeletion, syncPerformance, userPatches]);

  const noteOn = useCallback((source: string, note: number): void => {
    if (!Number.isFinite(note)) return;
    const previous = noteSources.current.get(source);
    if (previous === note) return;
    if (!source.startsWith(SEQUENCE_SOURCE_PREFIX)) {
      sequenceRecorderRef.current?.noteOn(source, note);
    }
    let visibleNotesChanged = false;
    if (previous !== undefined) {
      noteSources.current.delete(source);
      if (noteOwnerCounts.current.remove(previous)) {
        visibleNotesChanged = true;
        engine.noteOff(previous);
      }
    }
    noteSources.current.set(source, note);
    if (noteOwnerCounts.current.add(note)) {
      visibleNotesChanged = true;
      engine.noteOn(note);
    }
    else engine.keyboardTrigger();
    if (visibleNotesChanged) syncActiveNotes();
    // Web MIDI activity has no DOM gesture to wake the keepalive controller.
    // A failed real-time send marks the processor dirty; trigger its shared,
    // deduplicated recovery path now so the held-note replay is not delayed by
    // the watchdog interval.
    if (poweredRef.current && !engine.isAudioReady) {
      audioKeepAliveRef.current?.notifyAudioInterruption();
    }
  }, [engine, syncActiveNotes]);

  const noteOff = useCallback((source: string): void => {
    const note = noteSources.current.get(source);
    if (note === undefined) return;
    if (!source.startsWith(SEQUENCE_SOURCE_PREFIX)) {
      sequenceRecorderRef.current?.noteOff(source);
    }
    noteSources.current.delete(source);
    if (noteOwnerCounts.current.remove(note)) {
      engine.noteOff(note);
      syncActiveNotes();
    }
    if (poweredRef.current && !engine.isAudioReady) {
      audioKeepAliveRef.current?.notifyAudioInterruption();
    }
  }, [engine, syncActiveNotes]);

  const releasePhysicalNotes = useCallback((): void => {
    sequenceRecorderRef.current?.releaseMatching((source) => !source.startsWith(SEQUENCE_SOURCE_PREFIX));
    noteSources.current.clear();
    noteOwnerCounts.current.clear();
    midiSessionRef.current?.forgetHeldNotes();
    performanceSources.current = {
      ppcBendSemitones: 0,
      ppcVibratoSemitones: 0,
      midiBendNormalized: 0,
      midiModNormalized: 0,
    };
    setActiveNotes(new Set());
    engine.allNotesOff();
    engine.setPerformance({ bendSemitones: 0, vibratoSemitones: 0 });
  }, [engine]);

  const releaseUiNotes = useCallback((): void => {
    const isUiSource = (source: string): boolean => (
      source.startsWith("computer:")
      || source.startsWith("pointer:")
      || source.startsWith("visual-key:")
    );
    sequenceRecorderRef.current?.releaseMatching((source) => isUiSource(source));
    const releasedNotes = new Set<number>();
    for (const [source, note] of noteSources.current) {
      if (!isUiSource(source)) continue;
      noteSources.current.delete(source);
      if (noteOwnerCounts.current.remove(note)) releasedNotes.add(note);
    }
    for (const note of releasedNotes) engine.noteOff(note);
    performanceSources.current.ppcBendSemitones = 0;
    performanceSources.current.ppcVibratoSemitones = 0;
    if (releasedNotes.size > 0) syncActiveNotes();
    syncPerformance();
  }, [engine, syncActiveNotes, syncPerformance]);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      const note = KEYBOARD_MAP[event.code];
      if (
        note === undefined
        || event.repeat
        || reservesComputerKeyboardChord(event)
        || blocksComputerKeyboardNotes(event.target)
      ) return;
      event.preventDefault();
      noteOn(`computer:${event.code}`, note);
    };
    const up = (event: KeyboardEvent): void => {
      if (KEYBOARD_MAP[event.code] === undefined) return;
      noteOff(`computer:${event.code}`);
    };
    const blur = (): void => releaseUiNotes();
    const visibility = (): void => {
      if (document.hidden) releaseUiNotes();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [noteOff, noteOn, releaseUiNotes]);

  const finishSequenceRecording = useCallback((reason: "manual" | "idle"): void => {
    const recorder = sequenceRecorderRef.current;
    if (!mountedRef.current || !recorder?.isRecording) return;
    const take = recorder.finish();
    setSequenceRecording(false);
    setDirectEditor(null);
    setPatchLibraryDialog(null);
    revokeActiveLibraryDeletion("Recording review replaced the deletion dialog.");
    setHelpDialogOrigin(null);
    setSequenceTake({ take, origin: recordButtonRef.current });
    setNotice(reason === "idle"
      ? "Recording stopped after one minute without a played note. Save or discard the take."
      : "Recording stopped. Save or discard the take.");
  }, [revokeActiveLibraryDeletion]);
  finishRecordingRef.current = finishSequenceRecording;

  useEffect(() => {
    const recorder = new NoteSequenceRecorder(() => finishRecordingRef.current("idle"));
    const player = new NoteSequencePlayer({
      noteOn,
      noteOff,
      finished: (reason) => {
        if (!mountedRef.current) return;
        setSequencePlaybackState("stopped");
        setNotice(reason === "ended" ? "Sequence playback finished." : "Sequence playback stopped.");
      },
    });
    sequenceRecorderRef.current = recorder;
    sequencePlayerRef.current = player;
    return () => {
      recorder.dispose();
      player.dispose();
      if (sequenceRecorderRef.current === recorder) sequenceRecorderRef.current = null;
      if (sequencePlayerRef.current === player) sequencePlayerRef.current = null;
    };
  }, [noteOff, noteOn]);

  useEffect(() => {
    const pauseForBackground = (): void => {
      if (sequenceLifecyclePausedRef.current) return;
      // Cancel a Play request that is still awaiting audio startup. Main-page
      // timers are not reliable while a document is frozen or backgrounded.
      sequenceOperationRef.current += 1;
      const player = sequencePlayerRef.current;
      // A user-paused sequence is already safe for suspension, but it is not
      // stopped. Preserve that distinction so Stop remains available to
      // rewind it and Play still advertises a resume after the tab returns.
      if (player?.isPaused) {
        if (mountedRef.current) setSequencePlaybackState("paused");
        return;
      }
      if (!player?.pause()) {
        // A Play request can still be waiting for audio startup with no player
        // timer to pause. Its operation token was revoked above; also release
        // the visible pending transport state.
        if (mountedRef.current) setSequencePlaybackState("stopped");
        return;
      }
      sequenceLifecyclePausedRef.current = true;
      if (mountedRef.current) setSequencePlaybackState("paused");
    };
    const resumeFromBackground = (): void => {
      if (!sequenceLifecyclePausedRef.current) return;
      // `pageshow` and the Page Lifecycle `resume` event can run while a tab
      // is still backgrounded (for example, a BFCache restore into an
      // inactive tab). Keep the sequence frozen until visibility is actually
      // restored so overdue timers never burst through a hidden audio graph.
      if (document.hidden) return;
      sequenceLifecyclePausedRef.current = false;
      const player = sequencePlayerRef.current;
      if (!poweredRef.current || !player?.isPaused) return;
      if (player.resume() && mountedRef.current) setSequencePlaybackState("playing");
    };
    const visibilityChanged = (): void => {
      if (document.hidden) pauseForBackground();
      else resumeFromBackground();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    document.addEventListener("freeze", pauseForBackground);
    document.addEventListener("resume", resumeFromBackground);
    window.addEventListener("pagehide", pauseForBackground);
    window.addEventListener("pageshow", resumeFromBackground);
    return () => {
      sequenceLifecyclePausedRef.current = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      document.removeEventListener("freeze", pauseForBackground);
      document.removeEventListener("resume", resumeFromBackground);
      window.removeEventListener("pagehide", pauseForBackground);
      window.removeEventListener("pageshow", resumeFromBackground);
    };
  }, []);

  const toggleSequenceRecording = useCallback((): void => {
    const recorder = sequenceRecorderRef.current;
    if (!recorder) return;
    if (recorder.isRecording) {
      finishSequenceRecording("manual");
      return;
    }
    if (updateBusyRef.current) {
      setNotice("Wait for the app update to finish before starting a recording.");
      return;
    }

    sequenceOperationRef.current += 1;
    sequencePlayerRef.current?.stop(false);
    setSequencePlaybackState("stopped");
    setSequenceTake(null);
    setDirectEditor(null);
    setPatchLibraryDialog(null);
    revokeActiveLibraryDeletion("Recording started while deletion was pending.");
    setHelpDialogOrigin(null);
    recorder.start(
      [...noteSources.current].filter(([source]) => !source.startsWith(SEQUENCE_SOURCE_PREFIX)),
    );
    setSequenceRecording(true);
    setNotice("Recording keyboard notes. Press Record again to stop; one minute of silence stops automatically.");
  }, [finishSequenceRecording, revokeActiveLibraryDeletion]);

  const selectSequence = useCallback((name: string): void => {
    sequenceOperationRef.current += 1;
    sequencePlayerRef.current?.stop(false);
    setSequencePlaybackState("stopped");
    if (!name) {
      activeSequenceTakeRef.current = null;
      activeSequenceDataRef.current = null;
      setActiveSequenceName(null);
      setNotice("No sequence is loaded.");
      return;
    }
    const sequence = userSequences.find((candidate) => candidate.name === name);
    if (!sequence) {
      activeSequenceTakeRef.current = null;
      activeSequenceDataRef.current = null;
      setActiveSequenceName(null);
      setNotice("That saved sequence is no longer available.");
      return;
    }
    const decoded = decodeUserSequence(sequence);
    if (!decoded) {
      activeSequenceTakeRef.current = null;
      activeSequenceDataRef.current = null;
      setActiveSequenceName(null);
      setNotice("That saved sequence is damaged and could not be loaded.");
      return;
    }
    activeSequenceTakeRef.current = decoded;
    activeSequenceDataRef.current = sequence.data;
    setActiveSequenceName(sequence.name);
    setNotice(`Loaded sequence “${sequence.name}”.`);
  }, [userSequences]);

  const saveSequenceTake = async (
    name: string,
    signal: AbortSignal,
  ): Promise<SequenceSaveOutcome> => {
    const take = sequenceTake?.take;
    if (!take) return "That recording is no longer available.";
    // A replacement is a deliberate two-step UI path. Resolve a duplicate
    // from the already-validated library state before compacting an unlimited
    // take, so confirmation does not encode every event once for Save and a
    // second time for Replace. The locked storage operation remains the final
    // authority and still catches a duplicate created by another tab.
    const normalizedName = normalizeUserSequenceName(name);
    const existingSequence = normalizedName
      ? userSequences.find(
        (sequence) => userSequenceNameKey(sequence.name) === userSequenceNameKey(normalizedName),
      )
      : null;
    if (existingSequence) {
      return {
        status: "duplicate",
        existingSequence: {
          name: existingSequence.name,
          data: existingSequence.data,
          durationMs: existingSequence.durationMs,
          noteCount: existingSequence.noteCount,
          eventCount: existingSequence.eventCount,
        },
      };
    }
    const cancellation = browserOperations.begin(
      "sequence-save",
      "Sequence save was cancelled because Andoracle closed.",
    );
    const cancelWhenAborted = (): void => cancellation.cancel();
    signal.addEventListener("abort", cancelWhenAborted, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      const result = await cancellation.race(
        saveUserSequenceSafely(name, take, undefined, undefined, cancellation.signal),
      );
      switch (result.status) {
        case "saved":
          setUserSequences(result.sequences);
          activeSequenceTakeRef.current = take;
          activeSequenceDataRef.current = result.sequence.data;
          setActiveSequenceName(result.sequence.name);
          setSequenceTake(null);
          setNotice(`Saved and loaded sequence “${result.sequence.name}” on this device.`);
          return null;
        case "empty-name":
          setUserSequences(result.sequences);
          return "Enter a sequence name. A name cannot contain only whitespace.";
        case "name-too-long":
          setUserSequences(result.sequences);
          return `Sequence names can contain no more than ${result.maxLength} characters.`;
        case "duplicate-name":
          setUserSequences(result.sequences);
          return { status: "duplicate", existingSequence: result.existingSequence };
        case "invalid-sequence":
          return "This recording is incomplete and cannot be saved. Discard it and record again.";
        case "storage-error":
          return "This sequence could not be saved. Local storage may be blocked or full.";
        case "unsupported-version":
          return "This sequence library was created by a newer Andoracle version and cannot be changed safely.";
        case "busy":
          setUserSequences(result.sequences);
          return "Another Andoracle tab is saving a sequence right now. Try again.";
      }
    } finally {
      if (signal.aborted && mountedRef.current) {
        const refreshed = readUserSequences();
        if (refreshed.status === "ok" || refreshed.status === "recovered") {
          setUserSequences(refreshed.sequences);
        }
      }
      signal.removeEventListener("abort", cancelWhenAborted);
      browserOperations.finish("sequence-save", cancellation);
    }
  };

  const replaceSequenceTake = async (
    expected: UserNoteSequence,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const take = sequenceTake?.take;
    if (!take) return "That recording is no longer available.";
    const cancellation = browserOperations.begin(
      "sequence-replace",
      "Sequence replacement was cancelled before it completed.",
    );
    const cancelWhenAborted = (): void => cancellation.cancel();
    signal.addEventListener("abort", cancelWhenAborted, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      const result = await cancellation.race(
        replaceUserSequenceSafely(expected, take, undefined, undefined, cancellation.signal),
      );
      switch (result.status) {
        case "replaced":
          setUserSequences(result.sequences);
          sequenceOperationRef.current += 1;
          sequencePlayerRef.current?.stop(false);
          setSequencePlaybackState("stopped");
          activeSequenceTakeRef.current = take;
          activeSequenceDataRef.current = result.sequence.data;
          setActiveSequenceName(result.sequence.name);
          setSequenceTake(null);
          setNotice(`Replaced and loaded sequence “${result.sequence.name}” on this device.`);
          return null;
        case "empty-name":
          setUserSequences(result.sequences);
          return "That saved sequence no longer has a valid name. Choose another name.";
        case "not-found":
          setUserSequences(result.sequences);
          return "That saved sequence was removed before it could be replaced. Choose another name.";
        case "stale-target":
          setUserSequences(result.sequences);
          return "That saved sequence changed in another Andoracle tab. Review it before replacing it.";
        case "invalid-sequence":
          return "This recording is incomplete and cannot replace the saved sequence. Discard it and record again.";
        case "storage-error":
          return "This sequence could not be replaced. Local storage may be blocked or full.";
        case "unsupported-version":
          return "This sequence library was created by a newer Andoracle version and cannot be changed safely.";
        case "busy":
          setUserSequences(result.sequences);
          return "Another Andoracle tab is changing the sequence library right now. Try again.";
      }
    } finally {
      if (signal.aborted && mountedRef.current) {
        const refreshed = readUserSequences();
        if (refreshed.status === "ok" || refreshed.status === "recovered") {
          setUserSequences(refreshed.sequences);
        }
      }
      signal.removeEventListener("abort", cancelWhenAborted);
      browserOperations.finish("sequence-replace", cancellation);
    }
  };

  const changeParam = useCallback((key: ParamKey, value: number): void => {
    const normalizedValue = normalizeParamValue(key, value);
    if (Object.is(paramsRef.current[key], normalizedValue)) return;
    urlSyncBlockedRef.current = false;
    setActiveUserPatchName(null);
    setPresetName("Custom patch");
    const next = { ...paramsRef.current, [key]: normalizedValue };
    paramsRef.current = next;
    setParams(next);
    engine.setParams({ [key]: normalizedValue } as Partial<SynthParams>);
    if (key === "ppcBendRange" || key === "ppcVibratoRange") syncPerformance(next);
    if (key === "delayTrails") {
      setNotice(normalizedValue > 0.5
        ? "Delay Trails on: repeats continue after keyboard release."
        : "Delay Trails off: repeats follow the VCA release and the next keyboard phrase starts clean.");
    }
  }, [engine, syncPerformance]);

  const openDirectEditor = useCallback((
    param: ParamKey,
    origin: HTMLElement,
    restoreOriginFocus: boolean,
  ): void => {
    setDirectEditor({
      param,
      origin,
      displayScale: param === "vco1Coarse" && paramsRef.current.vco1Mode < 0.5 ? 0.01 : 1,
      restoreOriginFocus,
    });
  }, []);

  const applyPatch = useCallback((name: string): void => {
    const preset = FACTORY_PRESETS.find((candidate) => candidate.name === name);
    if (!preset) return;
    urlSyncBlockedRef.current = false;
    const next = { ...preset.params };
    paramsRef.current = next;
    setParams(next);
    setActiveUserPatchName(null);
    setPresetName(preset.name);
    engine.setParams(next);
    syncPerformance(next);
    setNotice(`${preset.name} loaded.`);
  }, [engine, syncPerformance]);

  const openPatchLibrary = (mode: PatchLibraryMode, origin: HTMLElement): void => {
    const result = readUserPatches();
    if (result.status === "storage-error") {
      setNotice("User patch storage is unavailable. Check this browser's site-storage permissions.");
      return;
    }
    if (result.status === "unsupported-version") {
      setNotice("This user patch library was created by a newer Andoracle version. Update the app to use it safely.");
      return;
    }
    setUserPatches(result.patches);
    if (result.status === "recovered") {
      setNotice("Some invalid saved-patch data was ignored; the valid patches remain available.");
    }
    setDirectEditor(null);
    revokeActiveLibraryDeletion("The patch library replaced the deletion dialog.");
    setPatchLibraryDialog({ mode, origin });
  };

  const saveNamedPatch = async (
    name: string,
    signal: AbortSignal,
  ): Promise<PatchSaveOutcome> => {
    const normalizedName = normalizeUserPatchName(name);
    if (normalizedName && RESERVED_PATCH_NAMES.has(userPatchNameKey(normalizedName))) {
      return `“${normalizedName}” is already used by the factory patch selector. Choose a different name.`;
    }

    const cancellation = browserOperations.begin(
      "patch-save",
      "Patch save was cancelled because Andoracle closed.",
    );
    const cancelWhenAborted = (): void => cancellation.cancel();
    signal.addEventListener("abort", cancelWhenAborted, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      const result = await cancellation.race(
        saveUserPatchSafely(name, paramsRef.current, undefined, undefined, cancellation.signal),
      );
      switch (result.status) {
        case "saved":
          setUserPatches(result.patches);
          setActiveUserPatchName(result.patch.name);
          setPresetName("Custom patch");
          setNotice(`Saved user patch “${result.patch.name}” on this device.`);
          return null;
        case "empty-name":
          setUserPatches(result.patches);
          return "Enter a patch name. A name cannot contain only whitespace.";
        case "name-too-long":
          setUserPatches(result.patches);
          return `Patch names can contain no more than ${result.maxLength} characters.`;
        case "duplicate-name":
          setUserPatches(result.patches);
          return { status: "duplicate", existingPatch: result.existingPatch };
        case "immutable-name":
          setUserPatches(result.patches);
          return `“${result.immutableName}” is a built-in patch name and can never be modified. Choose a different name.`;
        case "storage-error":
          return "This patch could not be saved. Local storage may be blocked or full.";
        case "unsupported-version":
          return "This patch library was created by a newer Andoracle version and cannot be changed safely.";
        case "busy":
          setUserPatches(result.patches);
          return "Another Andoracle tab is saving a patch right now. Try again.";
      }
    } finally {
      if (signal.aborted && mountedRef.current) {
        const refreshed = readUserPatches();
        if (refreshed.status === "ok" || refreshed.status === "recovered") {
          setUserPatches(refreshed.patches);
        }
      }
      signal.removeEventListener("abort", cancelWhenAborted);
      browserOperations.finish("patch-save", cancellation);
    }
  };

  const replaceNamedPatch = async (
    expected: UserPatch,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const cancellation = browserOperations.begin(
      "patch-replace",
      "Patch replacement was cancelled before it completed.",
    );
    const cancelWhenAborted = (): void => cancellation.cancel();
    signal.addEventListener("abort", cancelWhenAborted, { once: true });
    if (signal.aborted) cancellation.cancel();
    try {
      const result = await cancellation.race(
        replaceUserPatchSafely(expected, paramsRef.current, undefined, undefined, cancellation.signal),
      );
      switch (result.status) {
        case "replaced":
          setUserPatches(result.patches);
          setActiveUserPatchName(result.patch.name);
          setPresetName("Custom patch");
          setNotice(`Replaced user patch “${result.patch.name}” with the current settings.`);
          return null;
        case "empty-name":
          setUserPatches(result.patches);
          return "That saved patch no longer has a valid name. Choose another name.";
        case "not-found":
          setUserPatches(result.patches);
          return "That saved patch was removed before it could be replaced. Choose another name.";
        case "stale-target":
          setUserPatches(result.patches);
          return "That saved patch changed in another Andoracle tab. Review it before replacing it.";
        case "immutable-name":
          setUserPatches(result.patches);
          return `“${result.immutableName}” is built in and can never be modified.`;
        case "storage-error":
          return "This patch could not be replaced. Local storage may be blocked or full.";
        case "unsupported-version":
          return "This patch library was created by a newer Andoracle version and cannot be changed safely.";
        case "busy":
          setUserPatches(result.patches);
          return "Another Andoracle tab is changing the patch library right now. Try again.";
      }
    } finally {
      if (signal.aborted && mountedRef.current) {
        const refreshed = readUserPatches();
        if (refreshed.status === "ok" || refreshed.status === "recovered") {
          setUserPatches(refreshed.patches);
        }
      }
      signal.removeEventListener("abort", cancelWhenAborted);
      browserOperations.finish("patch-replace", cancellation);
    }
  };

  const loadNamedPatch = useCallback((name: string): string | null => {
    const patch = userPatches.find((candidate) => candidate.name === name);
    if (!patch) return "That saved patch is no longer available. Close this dialog and try again.";

    urlSyncBlockedRef.current = false;
    const next = { ...patch.params };
    paramsRef.current = next;
    setParams(next);
    setActiveUserPatchName(patch.name);
    setPresetName("Custom patch");
    setDirectEditor(null);
    engine.setParams(next);
    syncPerformance(next);
    setNotice(`Loaded user patch “${patch.name}”. Audio power and connected devices were left unchanged.`);
    return null;
  }, [engine, syncPerformance, userPatches]);

  const selectUserPatch = useCallback((name: string): void => {
    const error = loadNamedPatch(name);
    if (error) setNotice(error);
  }, [loadNamedPatch]);

  const openActivePatchDeletion = (origin: HTMLButtonElement): void => {
    if (sequenceRecording || sequenceRecorderRef.current?.isRecording) {
      setNotice("Stop and save or discard the current recording before deleting a patch.");
      return;
    }
    const patch = activeUserPatchName
      ? userPatches.find(
        (candidate) => userPatchNameKey(candidate.name) === userPatchNameKey(activeUserPatchName),
      )
      : null;
    if (!patch) {
      setNotice("Load a user-created patch before deleting it. Built-in and unsaved patches are immutable library sources.");
      return;
    }
    setDirectEditor(null);
    setPatchLibraryDialog(null);
    setHelpDialogOrigin(null);
    setDeleteConfirmation({ kind: "patch", patch, origin });
  };

  const openActiveRecordingDeletion = useCallback((origin: HTMLButtonElement): void => {
    const sequence = activeSequenceName
      ? userSequences.find(
        (candidate) => userSequenceNameKey(candidate.name) === userSequenceNameKey(activeSequenceName),
      )
      : null;
    if (!sequence || sequenceRecording) {
      setNotice("Load a saved recording before deleting it.");
      return;
    }
    setDirectEditor(null);
    setPatchLibraryDialog(null);
    setHelpDialogOrigin(null);
    setDeleteConfirmation({ kind: "recording", sequence, origin });
  }, [activeSequenceName, sequenceRecording, userSequences]);

  const beginDeleteOperationAuthority = (
    kind: DeleteConfirmationTarget["kind"],
    dialogSignal: AbortSignal,
  ): {
    readonly signal: AbortSignal;
    readonly release: () => void;
  } => {
    const previous = activeDeleteOperationRef.current;
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(
        new DOMException("A newer deletion replaced this operation.", "AbortError"),
      );
    }

    const controller = new AbortController();
    const operation: ActiveDeleteOperation = { kind, controller };
    activeDeleteOperationRef.current = operation;
    const abortFromDialog = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(dialogSignal.reason ?? new DOMException("Deletion was cancelled.", "AbortError"));
      }
    };
    dialogSignal.addEventListener("abort", abortFromDialog, { once: true });
    if (dialogSignal.aborted) abortFromDialog();

    return {
      signal: controller.signal,
      release: () => {
        dialogSignal.removeEventListener("abort", abortFromDialog);
        if (activeDeleteOperationRef.current === operation) {
          activeDeleteOperationRef.current = null;
        }
      },
    };
  };

  const confirmLibraryDeletion = async (
    target: DeleteConfirmationTarget,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (target.kind === "patch") {
      const currentTarget = activeUserPatchName
        ? userPatches.find(
          (patch) => userPatchNameKey(patch.name) === userPatchNameKey(activeUserPatchName),
        )
        : null;
      if (
        !currentTarget
        || userPatchNameKey(currentTarget.name) !== userPatchNameKey(target.patch.name)
        || !PARAM_KEYS.every((key) => Object.is(currentTarget.params[key], target.patch.params[key]))
      ) {
        return "The active patch changed after confirmation opened. Nothing was deleted.";
      }
      const authority = beginDeleteOperationAuthority("patch", signal);
      const cancellation = browserOperations.begin(
        "patch-delete",
        "Patch deletion was cancelled before it completed.",
      );
      const cancelWhenAborted = (): void => cancellation.cancel();
      authority.signal.addEventListener("abort", cancelWhenAborted, { once: true });
      if (authority.signal.aborted) cancellation.cancel();
      try {
        const result = await cancellation.race(
          deleteUserPatchSafely(target.patch, undefined, undefined, authority.signal),
        );
        switch (result.status) {
          case "deleted":
            setUserPatches(result.patches);
            setActiveUserPatchName(null);
            setPresetName(matchingPresetName(paramsRef.current));
            setNotice(`Deleted user patch “${result.deletedName}”. The current controls and share URL were kept.`);
            return null;
          case "not-found":
            setUserPatches(result.patches);
            setActiveUserPatchName(null);
            setPresetName(matchingPresetName(paramsRef.current));
            setNotice("That user patch was already removed. The current controls were kept.");
            return null;
          case "stale-target":
            setUserPatches(result.patches);
            setActiveUserPatchName(null);
            setPresetName(matchingPresetName(paramsRef.current));
            setNotice("That patch changed after confirmation opened, so the replacement was not deleted. Your current controls were kept.");
            return null;
          case "empty-name":
            return "No user patch is selected for deletion.";
          case "immutable-name":
            setUserPatches(result.patches);
            return `“${result.immutableName}” is built in and can never be deleted or modified.`;
          case "storage-error":
            return "This patch could not be deleted. Local storage may be blocked or unavailable.";
          case "unsupported-version":
            return "This patch library was created by a newer Andoracle version and cannot be changed safely.";
          case "busy":
            setUserPatches(result.patches);
            return "Another Andoracle tab is changing the patch library right now. Try again.";
        }
      } finally {
        if (authority.signal.aborted && mountedRef.current) {
          const refreshed = readUserPatches();
          if (refreshed.status === "ok" || refreshed.status === "recovered") {
            setUserPatches(refreshed.patches);
            if (!refreshed.patches.some(
              (patch) => userPatchNameKey(patch.name) === userPatchNameKey(target.patch.name),
            )) {
              setNotice("Patch deletion cancellation was requested after the library changed. The patch may already have been deleted.");
            }
          }
        }
        authority.signal.removeEventListener("abort", cancelWhenAborted);
        authority.release();
        browserOperations.finish("patch-delete", cancellation);
      }
    }

    if (target.kind !== "recording") return "No saved recording is selected for deletion.";
    const currentTarget = activeSequenceName
      ? userSequences.find(
        (sequence) => userSequenceNameKey(sequence.name) === userSequenceNameKey(activeSequenceName),
      )
      : null;
    if (
      !currentTarget
      || userSequenceNameKey(currentTarget.name) !== userSequenceNameKey(target.sequence.name)
      || currentTarget.data !== target.sequence.data
      || currentTarget.durationMs !== target.sequence.durationMs
      || currentTarget.noteCount !== target.sequence.noteCount
      || currentTarget.eventCount !== target.sequence.eventCount
    ) {
      return "The active recording changed after confirmation opened. Nothing was deleted.";
    }
    const authority = beginDeleteOperationAuthority("recording", signal);
    const cancellation = browserOperations.begin(
      "sequence-delete",
      "Recording deletion was cancelled before it completed.",
    );
    const cancelWhenAborted = (): void => cancellation.cancel();
    authority.signal.addEventListener("abort", cancelWhenAborted, { once: true });
    if (authority.signal.aborted) cancellation.cancel();
    try {
      const result = await cancellation.race(
        deleteUserSequenceSafely(target.sequence, undefined, undefined, authority.signal),
      );
      switch (result.status) {
        case "deleted":
          sequenceOperationRef.current += 1;
          sequencePlayerRef.current?.stop(false);
          activeSequenceTakeRef.current = null;
          activeSequenceDataRef.current = null;
          setSequencePlaybackState("stopped");
          setActiveSequenceName(null);
          setUserSequences(result.sequences);
          setNotice(`Deleted recording “${result.deletedName}”. Playback was stopped and returned to the beginning.`);
          return null;
        case "not-found":
          sequenceOperationRef.current += 1;
          sequencePlayerRef.current?.stop(false);
          activeSequenceTakeRef.current = null;
          activeSequenceDataRef.current = null;
          setSequencePlaybackState("stopped");
          setActiveSequenceName(null);
          setUserSequences(result.sequences);
          setNotice("That recording was already removed. It has been unloaded.");
          return null;
        case "stale-target":
          setUserSequences(result.sequences);
          setNotice("That recording changed after confirmation opened, so the replacement was not deleted. Review it and try again.");
          return null;
        case "empty-name":
          return "No saved recording is selected for deletion.";
        case "storage-error":
          return "This recording could not be deleted. Local storage may be blocked or unavailable.";
        case "unsupported-version":
          return "This recording library was created by a newer Andoracle version and cannot be changed safely.";
        case "busy":
          setUserSequences(result.sequences);
          return "Another Andoracle tab is changing the recording library right now. Try again.";
      }
    } finally {
      if (authority.signal.aborted && mountedRef.current) {
        const refreshed = readUserSequences();
        if (refreshed.status === "ok" || refreshed.status === "recovered") {
          const targetStillExists = refreshed.sequences.some(
            (sequence) => userSequenceNameKey(sequence.name) === userSequenceNameKey(target.sequence.name),
          );
          if (!targetStillExists) {
            // Reconcile the loaded take before publishing the refreshed list.
            // Otherwise the cross-tab effect sees a transient missing active
            // name and overwrites this local cancellation/timeout explanation.
            sequenceOperationRef.current += 1;
            sequencePlayerRef.current?.stop(false);
            activeSequenceTakeRef.current = null;
            activeSequenceDataRef.current = null;
            setSequencePlaybackState("stopped");
            setActiveSequenceName(null);
            setNotice("Recording deletion cancellation was requested after the library changed. The recording may already have been deleted.");
          }
          setUserSequences(refreshed.sequences);
        }
      }
      authority.signal.removeEventListener("abort", cancelWhenAborted);
      authority.release();
      browserOperations.finish("sequence-delete", cancellation);
    }
  };

  const togglePower = async (): Promise<void> => {
    if (externalInputBusy) return;
    if (powerBusy) {
      // A short power-down ramp does not need interruption, but a browser can
      // otherwise leave AudioWorklet startup pending indefinitely.
      if (powered) return;
      sequenceOperationRef.current += 1;
      setSequencePlaybackState("stopped");
      const operation = ++powerOperationRef.current;
      setNotice("Cancelling audio startup…");
      audioKeepAliveRef.current?.disable();
      try {
        await engine.powerOff();
        if (!mountedRef.current || operation !== powerOperationRef.current) return;
        setPowered(false);
        setNotice("Audio startup cancelled.");
      } catch (error) {
        if (!mountedRef.current || operation !== powerOperationRef.current) return;
        if (!(error instanceof Error) || error.name !== "AbortError") {
          setNotice(error instanceof Error ? error.message : "Audio startup could not be cancelled.");
        }
      } finally {
        if (mountedRef.current && operation === powerOperationRef.current) setPowerBusy(false);
      }
      return;
    }
    const operation = ++powerOperationRef.current;
    setPowerBusy(true);
    try {
      if (powered) {
        audioKeepAliveRef.current?.disable();
        sequenceOperationRef.current += 1;
        sequencePlayerRef.current?.stop(false);
        setSequencePlaybackState("stopped");
        if (sequenceRecorderRef.current?.isRecording) finishSequenceRecording("manual");
        engine.disableExternalInput();
        externalInputEnabledRef.current = false;
        if (mountedRef.current) setExternalInputEnabled(false);
        await engine.powerOff();
        if (!mountedRef.current || operation !== powerOperationRef.current) return;
        setPowered(false);
        setNotice("Audio suspended. Your patch is still here.");
      } else {
        audioKeepAliveRef.current?.enableFromUserGesture();
        await engine.powerOn(paramsRef.current);
        if (!mountedRef.current || operation !== powerOperationRef.current) return;
        for (const note of new Set(noteSources.current.values())) engine.noteOn(note);
        syncPerformance();
        setPowered(true);
        setNotice("Audio running. Output is limited for safe live control.");
      }
    } catch (error) {
      if (!mountedRef.current || operation !== powerOperationRef.current) return;
      audioKeepAliveRef.current?.disable();
      setPowered(false);
      setNotice(error instanceof Error && error.name === "AbortError"
        ? "Audio operation cancelled."
        : error instanceof Error ? error.message : "Audio could not start.");
    } finally {
      if (mountedRef.current && operation === powerOperationRef.current) setPowerBusy(false);
    }
  };

  const playSequence = useCallback(async (): Promise<void> => {
    const player = sequencePlayerRef.current;
    if (!player || sequenceRecording) return;
    if (player.isPlaying) return;
    const resuming = player.isPaused;

    const sequence = activeSequenceName
      ? userSequences.find(
        (candidate) => userSequenceNameKey(candidate.name) === userSequenceNameKey(activeSequenceName),
      )
      : null;
    if (!sequence) {
      sequenceOperationRef.current += 1;
      player.stop(false);
      setSequencePlaybackState("stopped");
      setActiveSequenceName(null);
      setNotice("Load or save a sequence before pressing Play.");
      return;
    }
    const playbackTake = activeSequenceDataRef.current === sequence.data
      ? activeSequenceTakeRef.current
      : decodeUserSequence(sequence);
    if (!playbackTake) {
      sequenceOperationRef.current += 1;
      player.stop(false);
      activeSequenceTakeRef.current = null;
      activeSequenceDataRef.current = null;
      setSequencePlaybackState("stopped");
      setActiveSequenceName(null);
      setNotice("That saved sequence is damaged and could not be played.");
      return;
    }
    activeSequenceTakeRef.current = playbackTake;
    activeSequenceDataRef.current = sequence.data;
    if (powerBusy || externalInputBusy) {
      setNotice("Wait for the current audio operation, then press Play again.");
      return;
    }

    const sequenceOperation = ++sequenceOperationRef.current;
    if (!powered) {
      const powerOperation = ++powerOperationRef.current;
      setSequencePlaybackState("starting");
      setPowerBusy(true);
      audioKeepAliveRef.current?.enableFromUserGesture();
      try {
        await engine.powerOn(paramsRef.current);
        if (!mountedRef.current || powerOperation !== powerOperationRef.current) return;
        for (const note of new Set(noteSources.current.values())) engine.noteOn(note);
        syncPerformance();
        setPowered(true);
        // Selection, stop, or deletion may cancel only the requested playback
        // while AudioContext startup is pending. Keep UI power synchronized
        // with the now-running engine, but never start the obsolete sequence.
        if (sequenceOperation !== sequenceOperationRef.current) return;
      } catch (error) {
        if (!mountedRef.current || powerOperation !== powerOperationRef.current) return;
        audioKeepAliveRef.current?.disable();
        setPowered(false);
        setSequencePlaybackState("stopped");
        setNotice(error instanceof Error && error.name === "AbortError"
          ? "Sequence playback was cancelled."
          : error instanceof Error ? error.message : "Audio could not start for sequence playback.");
        return;
      } finally {
        if (mountedRef.current && powerOperation === powerOperationRef.current) setPowerBusy(false);
      }
    }

    if (!mountedRef.current || sequenceOperation !== sequenceOperationRef.current) return;
    const started = resuming ? player.resume() : player.play(playbackTake);
    if (started && player.isPlaying) {
      setSequencePlaybackState("playing");
      setNotice(`${resuming ? "Resumed" : "Playing"} sequence “${sequence.name}”. Controls remain live.`);
    } else {
      setSequencePlaybackState("stopped");
    }
  }, [
    activeSequenceName,
    engine,
    externalInputBusy,
    powerBusy,
    powered,
    sequenceRecording,
    syncPerformance,
    userSequences,
  ]);

  const pauseSequencePlayback = useCallback((): void => {
    const player = sequencePlayerRef.current;
    if (!player?.pause()) return;
    sequenceOperationRef.current += 1;
    setSequencePlaybackState("paused");
    setNotice("Sequence paused. Play resumes from this position; Stop returns to the beginning.");
  }, []);

  const stopSequencePlayback = useCallback((): void => {
    const player = sequencePlayerRef.current;
    // Revoke even before NoteSequencePlayer is active so Stop can cancel a
    // Play request that is still awaiting AudioContext startup.
    sequenceOperationRef.current += 1;
    if (player?.isActive) player.stop();
    else setNotice("Sequence playback stopped and returned to the beginning.");
    setSequencePlaybackState("stopped");
  }, []);

  const toggleExternalInput = useCallback(async (): Promise<void> => {
    if (powerBusy) return;
    if (externalInputBusy) {
      // The first busy-state tap cancels. Keep later taps from publishing an
      // idle UI while that cancellation is still suspending its audio graph.
      const cancellationLease = externalInputCancellationGuard.acquire();
      if (cancellationLease === null) return;
      const operation = ++externalInputOperationRef.current;
      const shouldPowerOff = externalInputStartedPowerRef.current;
      externalInputStartedPowerRef.current = false;
      try {
        engine.disableExternalInput();
        audioKeepAliveRef.current?.setCaptureActive(false);
        externalInputEnabledRef.current = false;
        if (shouldPowerOff) {
          audioKeepAliveRef.current?.disable();
          try {
            await engine.powerOff();
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "AbortError") {
              if (mountedRef.current && operation === externalInputOperationRef.current) {
                setNotice(error instanceof Error ? error.message : "Live input cancellation failed.");
              }
            }
          }
        }
        if (!mountedRef.current || operation !== externalInputOperationRef.current) return;
        setExternalInputEnabled(false);
        setExternalInputBusy(false);
        setExternalInputError(null);
        setNotice("External audio connection cancelled.");
      } finally {
        externalInputCancellationGuard.release(cancellationLease);
      }
      return;
    }
    if (externalInputEnabled) {
      externalInputOperationRef.current += 1;
      externalInputStartedPowerRef.current = false;
      engine.disableExternalInput();
      audioKeepAliveRef.current?.setCaptureActive(false);
      externalInputEnabledRef.current = false;
      setExternalInputEnabled(false);
      setExternalInputError(null);
      setNotice("External audio input disconnected.");
      return;
    }
    const operation = ++externalInputOperationRef.current;
    const startedPower = !powered;
    externalInputStartedPowerRef.current = startedPower;
    setExternalInputBusy(true);
    setExternalInputError(null);
    try {
      if (startedPower) {
        audioKeepAliveRef.current?.enableFromUserGesture();
        await engine.powerOn(paramsRef.current);
        if (!mountedRef.current || operation !== externalInputOperationRef.current) return;
        for (const note of new Set(noteSources.current.values())) engine.noteOn(note);
        syncPerformance();
        setPowered(true);
      }
      audioKeepAliveRef.current?.setCaptureActive(true);
      await engine.enableExternalInput();
      if (!mountedRef.current || operation !== externalInputOperationRef.current) {
        engine.disableExternalInput();
        externalInputEnabledRef.current = false;
        return;
      }
      externalInputEnabledRef.current = true;
      setExternalInputEnabled(true);
      setExternalInputError(null);
      setNotice(paramsRef.current.delayTrails > 0.5
        ? "Live external input is feeding the mixer and synth path; Trails delay follows the VCA and drive."
        : "Live external input is feeding the mixer, then the keyboard-cut delay before the VCF.");
    } catch (error) {
      audioKeepAliveRef.current?.setCaptureActive(false);
      engine.disableExternalInput();
      externalInputEnabledRef.current = false;
      if (!mountedRef.current || operation !== externalInputOperationRef.current) return;
      if (startedPower) {
        audioKeepAliveRef.current?.disable();
        try {
          await engine.powerOff();
        } catch {
          // Preserve the original input error; power-off cleanup is best effort.
        }
        if (!mountedRef.current || operation !== externalInputOperationRef.current) return;
        setPowered(false);
      }
      setExternalInputEnabled(false);
      if (error instanceof Error && error.name === "AbortError") {
        setExternalInputError(null);
        setNotice("External audio connection cancelled.");
        return;
      }
      const message = error instanceof Error ? error.message : "External audio input could not connect.";
      setExternalInputError(message);
      setNotice(message);
    } finally {
      if (mountedRef.current && operation === externalInputOperationRef.current) setExternalInputBusy(false);
    }
  }, [
    engine,
    externalInputCancellationGuard,
    externalInputBusy,
    externalInputEnabled,
    powerBusy,
    powered,
    syncPerformance,
  ]);

  const panic = (): void => {
    sequenceOperationRef.current += 1;
    sequencePlayerRef.current?.stop(false);
    setSequencePlaybackState("stopped");
    if (sequenceRecorderRef.current?.isRecording) finishSequenceRecording("manual");
    setInputResetEpoch((epoch) => epoch + 1);
    releasePhysicalNotes();
    if (paramsRef.current.autoRun > 0.5) changeParam("autoRun", 0);
    // PANIC is a full-console reset, not merely All Notes Off. Leave the DSP
    // hard-muted after clearing oscillator/envelope/filter/drive state and
    // both delay rings. A subsequent note-on reopens it automatically; an
    // unconditional resume here would let a patch with Initial Gain (notably
    // Auto Drone) start sounding again immediately after Panic.
    engine.allSoundOff();
    setNotice("Panic cleared all notes, synth state, delay, and performance controls.");
  };

  const clearClipboardToast = (): void => {
    if (clipboardToastTimerRef.current !== null) {
      window.clearTimeout(clipboardToastTimerRef.current);
      clipboardToastTimerRef.current = null;
    }
    setClipboardToast(null);
  };

  const showClipboardToast = (): void => {
    if (clipboardToastTimerRef.current !== null) {
      window.clearTimeout(clipboardToastTimerRef.current);
    }
    setClipboardToast("Copied to clipboard");
    clipboardToastTimerRef.current = window.setTimeout(() => {
      clipboardToastTimerRef.current = null;
      if (mountedRef.current) setClipboardToast(null);
    }, CLIPBOARD_TOAST_DURATION_MS);
  };

  const sharePatch = async (): Promise<void> => {
    if (shareBusyRef.current) return;
    clearClipboardToast();

    urlSyncBlockedRef.current = false;
    // A user can Share inside the trailing persistence window after a dial
    // gesture. Flush both local storage and the URL before starting the native
    // share operation; merely clearing that timer would lose the latest
    // auto-restored patch snapshot on the next launch.
    persistPatchState(false);
    try {
      replacePatchUrl(paramsRef.current);
      lastHandledPatchHrefRef.current = window.location.href;
    } catch {
      setNotice("The patch is working, but this browser would not create its shareable URL.");
      return;
    }

    // Extension origins contain a browser- and installation-specific ID, so
    // share the equivalent public HTTPS patch URL from packaged builds.
    const shareUrl = import.meta.env.VITE_EXTENSION_BUILD === "true"
      ? urlWithPatch(import.meta.env.VITE_PUBLIC_APP_URL, paramsRef.current)
      : window.location.href;
    const hostOperation = patchShareOperationGate.run(
      shareUrl,
      () => performPatchShare(shareUrl),
    );
    if (hostOperation.status === "busy") {
      setNotice("A previous patch share is still finishing. Try again shortly.");
      return;
    }

    shareBusyRef.current = true;
    setShareBusy(true);
    const cancellation = browserOperations.begin(
      "share",
      "Patch sharing was cancelled because Andoracle closed.",
    );
    const deadline = createHostOperationDeadline(
      cancellation.cancel,
      HOST_OPERATION_UI_TIMEOUT_MS,
    );
    try {
      const result = await cancellation.race(hostOperation.promise);
      if (!mountedRef.current) return;
      if (result === "copied") showClipboardToast();
      else setNotice("Patch shared.");
    } catch (error) {
      if (!mountedRef.current) return;
      if (deadline.timedOut) {
        setNotice("Patch sharing timed out. Copy the patch URL from the address bar.");
      } else if (error instanceof Error && error.name === "AbortError") {
        setNotice("Patch sharing cancelled.");
      } else {
        setNotice("The current patch is in the URL. Copy it from your browser's address bar.");
      }
    } finally {
      deadline.dispose();
      browserOperations.finish("share", cancellation);
      shareBusyRef.current = false;
      if (mountedRef.current) setShareBusy(false);
    }
  };

  const performance = useCallback((state: Partial<PerformanceState>): void => {
    if (typeof state.bendSemitones === "number") {
      performanceSources.current.ppcBendSemitones = state.bendSemitones;
    }
    if (typeof state.vibratoSemitones === "number") {
      performanceSources.current.ppcVibratoSemitones = state.vibratoSemitones;
    }
    syncPerformance();
  }, [syncPerformance]);

  const midiPitchBend = useCallback((normalized: number): void => {
    performanceSources.current.midiBendNormalized = normalized;
    syncPerformance();
  }, [syncPerformance]);

  const midiModulation = useCallback((normalized: number): void => {
    performanceSources.current.midiModNormalized = normalized;
    syncPerformance();
  }, [syncPerformance]);

  const midiAllSoundOff = useCallback((): void => {
    // MIDI Channel Mode messages are channel-scoped. The DSP has one shared
    // Odyssey voice path. Hard-clear its envelope/delay state, then restore
    // notes owned by other channels or interfaces after WebMidiSession has
    // synchronously released the addressed channel.
    recoverAfterMidiAllSoundOff(
      engine,
      noteSources.current.values(),
      paramsRef.current.autoRun > 0.5 || externalInputEnabledRef.current,
    );
    if (poweredRef.current && !engine.isAudioReady) {
      audioKeepAliveRef.current?.notifyAudioInterruption();
    }
  }, [engine]);

  if (!midiSessionRef.current) {
    midiSessionRef.current = new WebMidiSession(NOOP_MIDI_HANDLERS);
  }

  useEffect(() => {
    const session = midiSessionRef.current;
    if (!session) return;
    session.setHandlers({
      noteOn,
      noteOff,
      pitchBend: midiPitchBend,
      modulation: midiModulation,
      allSoundOff: midiAllSoundOff,
      inputsChanged: (inputs) => {
        const previousError = midiErrorRef.current;
        setMidiInputs(inputs);
        // WebMidiSession publishes the complete topology before any errors for
        // that synchronization pass. Clear an older failure even when recovery
        // leaves a healthy, empty input list; a current failure is reapplied
        // immediately afterward by the error callback.
        updateMidiError(null);
        if (previousError !== null) {
          const recoveryNotice = midiReadyNotice(inputs);
          setNotice((current) => current === previousError ? recoveryNotice : current);
        }
      },
      error: (message) => {
        const detail = `MIDI input error: ${message}`;
        updateMidiError(detail);
        setNotice(detail);
      },
    });
    return () => session.setHandlers(NOOP_MIDI_HANDLERS);
  }, [midiAllSoundOff, midiModulation, midiPitchBend, noteOff, noteOn, updateMidiError]);

  const toggleMidi = useCallback(async (): Promise<void> => {
    if (!midiAvailability.supported) return;
    if (midiOperation !== null) {
      if (midiOperation === "disconnecting" || midiOperation === "cancelling") return;
      // Closing a native MIDI port can take seconds. Do not allow another
      // cancel tap to finish early and expose Connect over that pending close.
      const cancellationLease = midiCancellationGuard.acquire();
      if (cancellationLease === null) return;
      const operation = ++midiOperationRef.current;
      setMidiOperation("cancelling");
      setNotice("Cancelling MIDI operation…");
      try {
        await midiSessionRef.current?.disconnect();
        if (!mountedRef.current || operation !== midiOperationRef.current) return;
        setMidiEnabled(false);
        updateMidiError(null);
        setNotice("MIDI operation cancelled and inputs disconnected.");
      } catch (error) {
        if (!mountedRef.current || operation !== midiOperationRef.current) return;
        const message = error instanceof Error ? error.message : "MIDI operation could not be cancelled.";
        updateMidiError(message);
        setNotice(message);
      } finally {
        midiCancellationGuard.release(cancellationLease);
        if (mountedRef.current && operation === midiOperationRef.current) setMidiOperation(null);
      }
      return;
    }
    const operation = ++midiOperationRef.current;
    setMidiOperation(midiEnabled ? "disconnecting" : "connecting");
    updateMidiError(null);
    try {
      if (midiEnabled) {
        await midiSessionRef.current?.disconnect();
        if (!mountedRef.current || operation !== midiOperationRef.current) return;
        setMidiEnabled(false);
        updateMidiError(null);
        setNotice("MIDI input disconnected. Touch and computer keys remain available.");
      } else {
        const inputs = await midiSessionRef.current?.connect() ?? [];
        if (!mountedRef.current || operation !== midiOperationRef.current) return;
        setMidiEnabled(true);
        if (midiErrorRef.current === null) {
          setNotice(midiReadyNotice(inputs));
        }
      }
    } catch (error) {
      if (!mountedRef.current || operation !== midiOperationRef.current) return;
      setMidiEnabled(false);
      const denied = error instanceof DOMException
        && ["NotAllowedError", "SecurityError"].includes(error.name);
      const message = denied
        ? "MIDI access was not granted. Touch and computer keys still work."
        : error instanceof Error ? error.message : "MIDI could not connect.";
      updateMidiError(message);
      setNotice(message);
    } finally {
      if (mountedRef.current && operation === midiOperationRef.current) setMidiOperation(null);
    }
  }, [midiAvailability.supported, midiCancellationGuard, midiEnabled, midiOperation, updateMidiError]);

  const refreshMidi = useCallback(async (): Promise<void> => {
    if (midiOperation !== null) return;
    const operation = ++midiOperationRef.current;
    setMidiOperation("refreshing");
    updateMidiError(null);
    try {
      const inputs = await midiSessionRef.current?.refresh() ?? [];
      if (!mountedRef.current || operation !== midiOperationRef.current) return;
      if (midiErrorRef.current === null) {
        setNotice(inputs.length > 0
          ? `MIDI inputs refreshed: ${midiInputListLabel(inputs)}.`
          : "No MIDI input is currently detected.");
      }
    } catch (error) {
      if (!mountedRef.current || operation !== midiOperationRef.current) return;
      const message = error instanceof Error ? error.message : "MIDI inputs could not be refreshed.";
      updateMidiError(message);
      setNotice(message);
    } finally {
      if (mountedRef.current && operation === midiOperationRef.current) setMidiOperation(null);
    }
  }, [midiOperation, updateMidiError]);

  const install = async (): Promise<void> => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    setInstallPrompt(null);
    const cancellation = browserOperations.begin(
      "install",
      "App installation was cancelled because Andoracle closed.",
    );
    try {
      await cancellation.race(prompt.prompt());
      const choice = await cancellation.race(prompt.userChoice);
      if (!mountedRef.current) return;
      setNotice(choice.outcome === "accepted"
        ? "Andoracle is being installed."
        : "Installation was dismissed; you can still install Andoracle from your browser menu.");
    } catch (error) {
      if (!mountedRef.current) return;
      setNotice(error instanceof Error ? `Installation could not start: ${error.message}` : "Installation could not start.");
    } finally {
      browserOperations.finish("install", cancellation);
    }
  };

  const reloadUpdate = async (): Promise<void> => {
    if (updateBusyRef.current) return;
    if (sequenceRecorderRef.current?.isRecording) {
      setNotice("Stop and save or discard the current recording before reloading the app update.");
      return;
    }
    updateBusyRef.current = true;
    setUpdateBusy(true);
    // The service worker owns the navigation and may replace this document
    // before ordinary trailing persistence runs. Snapshot the latest controls
    // synchronously so an update never loses the final drag or key adjustment.
    persistPatchState(false);
    const cancellation = browserOperations.begin("pwa-update", "App update wait was cancelled.");
    const deadline = createHostOperationDeadline(
      cancellation.cancel,
      HOST_OPERATION_UI_TIMEOUT_MS,
    );
    try {
      await cancellation.race(updateServiceWorker(true));
    } catch (error) {
      if (!mountedRef.current) return;
      if (deadline.timedOut) {
        setNotice("App update timed out. Try again or choose Later.");
      } else if (!(error instanceof Error) || error.name !== "AbortError") {
        setNotice(error instanceof Error && error.name === "PwaUpdatePendingError"
          ? "A previous app update is still finishing. Try again shortly."
          : error instanceof Error ? `The app update could not reload: ${error.message}` : "The app update could not reload.");
      }
    } finally {
      deadline.dispose();
      browserOperations.finish("pwa-update", cancellation);
      updateBusyRef.current = false;
      if (mountedRef.current) setUpdateBusy(false);
    }
  };

  const physicalNoteExtremes = useMemo(() => findNoteExtremes(activeNotes), [activeNotes]);
  const allocatedLow = powered
    ? physicalNoteExtremes.low !== null
      ? physicalNoteExtremes.low
      : params.autoRun > 0.5
        ? Math.round(params.autoNote)
        : null
    : null;
  const allocatedHigh = powered
    ? physicalNoteExtremes.high !== null
      ? physicalNoteExtremes.high
      : allocatedLow
    : null;
  const midiHeaderControl = useMemo(() => (
    <MidiInputControl
      supported={midiAvailability.supported}
      unsupportedReason={midiAvailability.reason}
      enabled={midiEnabled}
      operation={midiOperation}
      error={midiError}
      inputs={midiInputs}
      onToggle={toggleMidi}
      onRefresh={refreshMidi}
    />
  ), [
    midiAvailability.reason,
    midiAvailability.supported,
    midiEnabled,
    midiError,
    midiInputs,
    midiOperation,
    refreshMidi,
    toggleMidi,
  ]);
  const changeKeyboardPosition = useCallback((position: KeyboardPosition): void => {
    setKeyboardPosition(position);
    try {
      window.localStorage.setItem(KEYBOARD_POSITION_STORAGE_KEY, position);
    } catch {
      // The layout still changes for this session when storage is unavailable.
    }
  }, []);
  const keyboardModule = (
    <Keyboard
      activeNotes={activeNotes}
      allocatedLow={allocatedLow}
      allocatedHigh={allocatedHigh}
      resetEpoch={inputResetEpoch}
      onNoteOn={noteOn}
      onNoteOff={noteOff}
      position={keyboardPosition}
      onPositionChange={changeKeyboardPosition}
      headerControl={midiHeaderControl}
    />
  );

  return (
    <>
      <div className="app-shell">
      <header className="topbar">
        <div className="console-identity-area">
          <div className="brand">
            <div>
              <div className="brand-name"><RasterLabel text="Andoracle" variant="brand" preserveCase /></div>
              <div className="brand-model"><RasterLabel text="Duophonic · Model 2800" variant="model" /></div>
            </div>
          </div>
          <div className="power-strip">
            <div className="power-control">
              <span className="power-control__label" aria-hidden="true"><RasterLabel text="Power" variant="control" /></span>
              <button
                type="button"
                className="toggle-switch power-switch"
                data-switch-variant="power"
                role="switch"
                aria-checked={powered}
                aria-busy={powerBusy || externalInputBusy}
                aria-label={externalInputBusy
                  ? "Audio operation in progress"
                  : powerBusy && !powered
                    ? "Cancel audio startup"
                    : powerBusy
                      ? "Audio power operation in progress"
                      : powered ? "Power off" : "Power on"}
                disabled={externalInputBusy || (powerBusy && powered)}
                onClick={togglePower}
              >
                <b aria-hidden="true"><RasterLabel text="Off" variant="micro" /></b>
                <span aria-hidden="true" />
                <b aria-hidden="true"><RasterLabel text="On" variant="micro" /></b>
              </button>
            </div>
          </div>
        </div>
        <div className="library-deck">
          <div className="utility-strip" role="group" aria-label="Global controls">
            <div className="library-actions utility-actions">
              <button
                type="button"
                className="button button--danger"
                aria-label="Panic: clear synth, delay, and all notes"
                onClick={panic}
              >
                <RasterLabel text="Panic" variant="button" tone="reverse" />
              </button>
              <button
                type="button"
                className="button button--quiet help-button"
                aria-haspopup="dialog"
                onClick={(event) => {
                  setDirectEditor(null);
                  setPatchLibraryDialog(null);
                  revokeActiveLibraryDeletion("Help replaced the deletion dialog.");
                  setHelpDialogOrigin(event.currentTarget);
                }}
              >
                <RasterLabel text="Help" variant="button" tone="reverse" />
              </button>
              <button
                type="button"
                className="button button--quiet share-button"
                disabled={shareBusy}
                onClick={() => void sharePatch()}
              >
                <RasterLabel text={shareBusy ? "Sharing…" : "Share Patch"} variant="button" tone="reverse" />
              </button>
              {installPrompt && <button type="button" className="button button--quiet install-button" onClick={install}>
                <RasterLabel text="Install app" variant="button" tone="reverse" />
              </button>}
            </div>
          </div>
          <div className="patch-strip">
            <div className="library-picker patch-picker">
              <label htmlFor="preset"><RasterLabel text="Patch" variant="control" /></label>
              <PatchSelector
                userPatches={userPatches}
                activeUserPatchName={activeUserPatchName}
                selectedFactoryName={presetName}
                onSelectUserPatch={selectUserPatch}
                onSelectFactoryPatch={applyPatch}
              />
            </div>
            <div className="library-actions patch-actions">
              <button
                type="button"
                className="button button--quiet"
                aria-haspopup="dialog"
                onClick={(event) => openPatchLibrary("save", event.currentTarget)}
              >
                <RasterLabel text="Save" variant="button" tone="reverse" />
              </button>
              <button
                type="button"
                className="button button--quiet"
                aria-haspopup="dialog"
                onClick={(event) => openPatchLibrary("load", event.currentTarget)}
              >
                <RasterLabel text="Load" variant="button" tone="reverse" />
              </button>
              <button
                type="button"
                className="button button--danger"
                aria-label="Delete active user patch"
                aria-haspopup="dialog"
                disabled={!activeUserPatchName || sequenceRecording}
                title={activeUserPatchName
                  ? sequenceRecording
                    ? "Stop and save or discard the current recording before deleting a patch"
                    : `Delete saved patch ${activeUserPatchName}`
                  : "Built-in and unsaved patches cannot be deleted or modified"}
                onClick={(event) => openActivePatchDeletion(event.currentTarget)}
              >
                <RasterLabel text="Delete" variant="button" tone="reverse" />
              </button>
              <button type="button" className="button button--quiet" onClick={() => applyPatch("Init Andoracle")}>
                <RasterLabel text="Initialize" variant="button" tone="reverse" />
              </button>
            </div>
          </div>
          <SequenceTransport
            sequenceNames={sequenceNames}
            activeName={activeSequenceName}
            recording={sequenceRecording}
            playbackState={sequencePlaybackState}
            recordButtonRef={recordButtonRef}
            onSelect={selectSequence}
            onRecord={toggleSequenceRecording}
            onPlay={playSequence}
            onPause={pauseSequencePlayback}
            onStop={stopSequencePlayback}
            onDelete={openActiveRecordingDeletion}
          />
        </div>
        <LiveOutputMeter engine={engine} running={powered} />
      </header>

      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{notice}</div>

      <main ref={performanceFocusRef} tabIndex={-1}>
        <h1 className="visually-hidden">Andoracle — ARP Odyssey-Inspired Duophonic Synthesizer</h1>
        {keyboardPosition === "top" && keyboardModule}
        <div className="panel-grid">
          {PANEL_SECTIONS.map((section) => (
            <SynthPanel
              key={section.id}
              section={section}
              params={params}
              externalInputEnabled={externalInputEnabled}
              externalInputBusy={externalInputBusy}
              externalInputError={externalInputError}
              powerBusy={powerBusy}
              inputResetEpoch={inputResetEpoch}
              onChange={changeParam}
              onDirectEdit={openDirectEditor}
              onToggleExternalInput={toggleExternalInput}
              onPerformance={performance}
            />
          ))}
        </div>
        {keyboardPosition === "bottom" && keyboardModule}
      </main>
      </div>

      {clipboardToast && (
        <div className="clipboard-toast" role="status" aria-live="polite" aria-atomic="true">
          {clipboardToast}
        </div>
      )}

      {audioStatus.error && (
        <aside className="system-banner system-banner--warning" role="alert" aria-live="assertive">
          <span>{audioStatus.error}</span>
        </aside>
      )}
      {(offlineReady || needRefresh) && (
        <aside className="system-banner" role="status" aria-live="polite">
          <span>{needRefresh ? "A newer app version is ready." : "The complete synth is ready offline."}</span>
          {needRefresh ? (
            <>
              <button type="button" disabled={updateBusy} onClick={() => void reloadUpdate()}>{updateBusy ? "Reloading…" : "Reload update"}</button>
              <button
                type="button"
                disabled={updateBusy}
                onClick={() => {
                  // Service-worker activation is browser-owned and cannot be
                  // cancelled once Reload update has begun. Keep “Later” from
                  // promising a postponement that the browser may ignore.
                  if (updateBusyRef.current) return;
                  setNeedRefresh(false);
                  // `offlineReady` can still be latched from the first-install
                  // callback when a later update arrives. “Later” dismisses
                  // the status area as one action instead of immediately
                  // revealing a second, stale offline-ready banner.
                  setOfflineReady(false);
                }}
              >
                Later
              </button>
            </>
          ) : <button type="button" onClick={() => setOfflineReady(false)}>Dismiss</button>}
        </aside>
      )}

      {directEditor && (
        <DirectEntryModal
          param={directEditor.param}
          value={params[directEditor.param]}
          displayScale={directEditor.displayScale}
          origin={directEditor.origin}
          fallbackOrigin={performanceFocusRef.current}
          restoreOriginFocus={directEditor.restoreOriginFocus}
          onApply={changeParam}
          onClose={() => setDirectEditor(null)}
        />
      )}
      {patchLibraryDialog && (
        <PatchLibraryDialog
          mode={patchLibraryDialog.mode}
          patchNames={patchNames}
          origin={patchLibraryDialog.origin}
          onSave={saveNamedPatch}
          onReplace={replaceNamedPatch}
          onLoad={loadNamedPatch}
          onClose={() => setPatchLibraryDialog(null)}
        />
      )}
      {deleteConfirmation && (
        <DeleteConfirmationDialog
          kind={deleteConfirmation.kind}
          name={deleteConfirmation.kind === "patch"
            ? deleteConfirmation.patch.name
            : deleteConfirmation.sequence.name}
          origin={deleteConfirmation.origin}
          fallbackOrigin={performanceFocusRef.current}
          onConfirm={(signal) => confirmLibraryDeletion(deleteConfirmation, signal)}
          onClose={() => revokeActiveLibraryDeletion("Delete confirmation closed.")}
        />
      )}
      {sequenceTake && (
        <SequenceCommitDialog
          take={sequenceTake.take}
          origin={sequenceTake.origin}
          onSave={saveSequenceTake}
          onReplace={replaceSequenceTake}
          onDiscard={() => {
            setSequenceTake(null);
            setNotice(
              activeSequenceName
                ? `Recording discarded. Sequence “${activeSequenceName}” remains loaded.`
                : "Recording discarded. No sequence is loaded.",
            );
          }}
        />
      )}
      {helpDialogOrigin && (
        <HelpDialog
          origin={helpDialogOrigin}
          onClose={() => setHelpDialogOrigin(null)}
        />
      )}
    </>
  );
}

export default App;
