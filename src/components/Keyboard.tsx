import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { midiNoteName } from "../synth/params";

interface KeyboardProps {
  activeNotes: ReadonlySet<number>;
  allocatedLow: number | null;
  allocatedHigh: number | null;
  resetEpoch: number;
  onNoteOn: (source: string, note: number) => void;
  onNoteOff: (source: string) => void;
}

const START_NOTE = 36;
const END_NOTE = 72;
const WHITE_WIDTH = 48;
const BLACK_WIDTH = 30;
const WHITE_PITCHES = new Set([0, 2, 4, 5, 7, 9, 11]);

type VisualActivation = " " | "Enter" | "assistive";

export const isVisualActivationKey = (key: string): key is Exclude<VisualActivation, "assistive"> => (
  key === " " || key === "Enter"
);

export const visualKeySource = (note: number, activation: VisualActivation): string => {
  const token = activation === " " ? "Space" : activation;
  return `visual-key:${note}:${token}`;
};

export const isSyntheticActivationClick = (detail: number): boolean => detail === 0;

export const shouldToggleAssistiveKey = (detail: number, keyboardClickSuppressed: boolean): boolean => (
  isSyntheticActivationClick(detail) && !keyboardClickSuppressed
);

export const clearKeyboardOwnership = (
  pointerNotes: Map<number, number>,
  visualKeySources: Map<string, number>,
  clickSuppressions: Set<string>,
  suppressionTimers: Map<string, number>,
  onNoteOff: (source: string) => void,
  clearTimer: (timer: number) => void,
): void => {
  for (const pointerId of pointerNotes.keys()) onNoteOff(`pointer:${pointerId}`);
  for (const source of visualKeySources.keys()) onNoteOff(source);
  for (const timer of suppressionTimers.values()) clearTimer(timer);
  pointerNotes.clear();
  visualKeySources.clear();
  clickSuppressions.clear();
  suppressionTimers.clear();
};

interface KeyGeometry {
  note: number;
  white: boolean;
  left: number;
}

const isWhite = (note: number): boolean => WHITE_PITCHES.has(((note % 12) + 12) % 12);

export function Keyboard({
  activeNotes,
  allocatedLow,
  allocatedHigh,
  resetEpoch,
  onNoteOn,
  onNoteOff,
}: KeyboardProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pointerNotes = useRef(new Map<number, number>());
  const visualKeySources = useRef(new Map<string, number>());
  const clickSuppressions = useRef(new Set<string>());
  const suppressionTimers = useRef(new Map<string, number>());
  const keyElements = useRef(new Map<number, HTMLButtonElement>());
  const [focusedNote, setFocusedNote] = useState(START_NOTE);

  const releaseAll = (): void => clearKeyboardOwnership(
    pointerNotes.current,
    visualKeySources.current,
    clickSuppressions.current,
    suppressionTimers.current,
    onNoteOff,
    (timer) => window.clearTimeout(timer),
  );

  const geometry = useMemo<KeyGeometry[]>(() => {
    const result: KeyGeometry[] = [];
    let whiteCount = 0;
    for (let note = START_NOTE; note <= END_NOTE; note += 1) {
      if (isWhite(note)) {
        result.push({ note, white: true, left: whiteCount * WHITE_WIDTH });
        whiteCount += 1;
      } else {
        result.push({ note, white: false, left: whiteCount * WHITE_WIDTH - BLACK_WIDTH / 2 });
      }
    }
    return result;
  }, []);

  useEffect(() => {
    const releaseWhenHidden = (): void => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
      releaseAll();
    };
  }, [onNoteOff]);

  useEffect(() => {
    releaseAll();
  }, [resetEpoch]);

  const noteAtPoint = (x: number, y: number): number | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-note]");
    if (!element || !surfaceRef.current?.contains(element)) return null;
    const note = Number(element.dataset.note);
    return Number.isFinite(note) ? note : null;
  };

  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    const note = noteAtPoint(event.clientX, event.clientY);
    if (note === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerNotes.current.set(event.pointerId, note);
    onNoteOn(`pointer:${event.pointerId}`, note);
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = pointerNotes.current.get(event.pointerId);
    if (previous === undefined) return;
    const next = noteAtPoint(event.clientX, event.clientY);
    if (next === null || next === previous) return;
    const source = `pointer:${event.pointerId}`;
    onNoteOff(source);
    pointerNotes.current.set(event.pointerId, next);
    onNoteOn(source, next);
  };

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (!pointerNotes.current.has(event.pointerId)) return;
    onNoteOff(`pointer:${event.pointerId}`);
    pointerNotes.current.delete(event.pointerId);
  };

  const moveKeyboardFocus = (note: number): void => {
    const next = Math.max(START_NOTE, Math.min(END_NOTE, note));
    setFocusedNote(next);
    keyElements.current.get(next)?.focus();
  };

  const activateVisualKey = (note: number, activation: VisualActivation): void => {
    const source = visualKeySource(note, activation);
    if (visualKeySources.current.has(source)) return;
    visualKeySources.current.set(source, note);
    onNoteOn(source, note);
  };

  const suppressKeyboardClick = (note: number, activation: Exclude<VisualActivation, "assistive">): void => {
    const source = visualKeySource(note, activation);
    const pendingTimer = suppressionTimers.current.get(source);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    suppressionTimers.current.delete(source);
    clickSuppressions.current.add(source);
  };

  const deferKeyboardClickRelease = (note: number, activation: Exclude<VisualActivation, "assistive">): void => {
    const source = visualKeySource(note, activation);
    const pendingTimer = suppressionTimers.current.get(source);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      clickSuppressions.current.delete(source);
      suppressionTimers.current.delete(source);
    }, 0);
    suppressionTimers.current.set(source, timer);
  };

  const releaseVisualKey = (note: number, activation: VisualActivation): void => {
    const source = visualKeySource(note, activation);
    if (!visualKeySources.current.delete(source)) return;
    onNoteOff(source);
  };

  const releaseVisualNote = (note: number): void => {
    for (const [source, sourceNote] of visualKeySources.current) {
      if (sourceNote !== note) continue;
      visualKeySources.current.delete(source);
      onNoteOff(source);
    }
    for (const activation of [" ", "Enter"] as const) {
      const source = visualKeySource(note, activation);
      clickSuppressions.current.delete(source);
      const timer = suppressionTimers.current.get(source);
      if (timer !== undefined) window.clearTimeout(timer);
      suppressionTimers.current.delete(source);
    }
  };

  const syntheticClick = (note: number, event: MouseEvent<HTMLButtonElement>): void => {
    const keyboardClickSuppressed = ([" ", "Enter"] as const).some((activation) => (
      clickSuppressions.current.has(visualKeySource(note, activation))
    ));
    if (!shouldToggleAssistiveKey(event.detail, keyboardClickSuppressed)) return;
    const source = visualKeySource(note, "assistive");
    if (visualKeySources.current.delete(source)) onNoteOff(source);
    else activateVisualKey(note, "assistive");
  };

  const keyboardDown = (note: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        moveKeyboardFocus(note - 1);
        return;
      case "ArrowRight":
        event.preventDefault();
        moveKeyboardFocus(note + 1);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveKeyboardFocus(note - 12);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveKeyboardFocus(note + 12);
        return;
      case "Home":
        event.preventDefault();
        moveKeyboardFocus(START_NOTE);
        return;
      case "End":
        event.preventDefault();
        moveKeyboardFocus(END_NOTE);
        return;
      case " ":
      case "Enter":
        if (!event.repeat) {
          suppressKeyboardClick(note, event.key);
          activateVisualKey(note, event.key);
        }
        event.preventDefault();
        return;
    }
  };

  const keyboardUp = (note: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isVisualActivationKey(event.key)) return;
    event.preventDefault();
    releaseVisualKey(note, event.key);
    deferKeyboardClickRelease(note, event.key);
  };

  const whiteKeyCount = geometry.filter((key) => key.white).length;
  const panKeyboard = (direction: -1 | 1): void => {
    scrollRef.current?.scrollBy({
      left: direction * WHITE_WIDTH * 7,
      behavior: "auto",
    });
  };

  return (
    <section className="keyboard-module" aria-label="37-key keyboard">
      <div className="keyboard-header">
        <div>
          <span className="module-eyebrow">C2–C5 · low/high priority</span>
          <h2>37-key duophonic keyboard</h2>
        </div>
        <p><kbd>A S D F G H J K L ;</kbd> white · <kbd>W E T Y U O P</kbd> black. Drag for glissando.</p>
      </div>
      <div className="keyboard-pan-controls" role="group" aria-label="Keyboard viewport controls">
        <button type="button" onClick={() => panKeyboard(-1)} aria-label="Show lower keyboard octave">← Lower keys</button>
        <button type="button" onClick={() => panKeyboard(1)} aria-label="Show higher keyboard octave">Higher keys →</button>
      </div>
      <div ref={scrollRef} className="keyboard-scroll" role="group" aria-label="Scrollable on-screen keyboard">
        <div
          ref={surfaceRef}
          className="keyboard-surface"
          style={{ width: whiteKeyCount * WHITE_WIDTH }}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onContextMenu={(event) => event.preventDefault()}
        >
          {geometry.filter((key) => key.white).map((key) => {
            const active = activeNotes.has(key.note);
            const low = allocatedLow === key.note;
            const high = allocatedHigh === key.note;
            return (
              <button
                key={key.note}
                type="button"
                className={`piano-key piano-key--white${active ? " is-active" : ""}${low ? " is-low" : ""}${high ? " is-high" : ""}`}
                style={{ left: key.left, width: WHITE_WIDTH }}
                data-note={key.note}
                aria-label={midiNoteName(key.note)}
                aria-pressed={active}
                aria-keyshortcuts="Enter Space"
                tabIndex={focusedNote === key.note ? 0 : -1}
                ref={(element) => {
                  if (element) keyElements.current.set(key.note, element);
                  else keyElements.current.delete(key.note);
                }}
                onFocus={() => setFocusedNote(key.note)}
                onKeyDown={(event) => keyboardDown(key.note, event)}
                onKeyUp={(event) => keyboardUp(key.note, event)}
                onClick={(event) => syntheticClick(key.note, event)}
                onBlur={() => releaseVisualNote(key.note)}
              >
                {key.note % 12 === 0 && <span>{midiNoteName(key.note)}</span>}
              </button>
            );
          })}
          {geometry.filter((key) => !key.white).map((key) => {
            const active = activeNotes.has(key.note);
            const low = allocatedLow === key.note;
            const high = allocatedHigh === key.note;
            return (
              <button
                key={key.note}
                type="button"
                className={`piano-key piano-key--black${active ? " is-active" : ""}${low ? " is-low" : ""}${high ? " is-high" : ""}`}
                style={{ left: key.left, width: BLACK_WIDTH }}
                data-note={key.note}
                aria-label={midiNoteName(key.note)}
                aria-pressed={active}
                aria-keyshortcuts="Enter Space"
                tabIndex={focusedNote === key.note ? 0 : -1}
                ref={(element) => {
                  if (element) keyElements.current.set(key.note, element);
                  else keyElements.current.delete(key.note);
                }}
                onFocus={() => setFocusedNote(key.note)}
                onKeyDown={(event) => keyboardDown(key.note, event)}
                onKeyUp={(event) => keyboardUp(key.note, event)}
                onClick={(event) => syntheticClick(key.note, event)}
                onBlur={() => releaseVisualNote(key.note)}
              />
            );
          })}
        </div>
      </div>
      <div className="allocation-legend" aria-hidden="true">
        <span><i className="dot dot--low" /> VCO 1 / lowest</span>
        <span><i className="dot dot--high" /> VCO 2 / highest</span>
      </div>
    </section>
  );
}
