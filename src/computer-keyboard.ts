export const COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR = [
  "input",
  "select",
  "textarea",
  "dialog",
  "[role='textbox']",
  "[contenteditable]:not([contenteditable='false'])",
].join(", ");

interface ClosestTarget {
  closest(selectors: string): unknown;
}

interface ComputerKeyboardEventState {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
}

export const blocksComputerKeyboardNotes = (target: EventTarget | null): boolean => {
  const candidate = target as (EventTarget & Partial<ClosestTarget>) | null;
  return typeof candidate?.closest === "function"
    && Boolean(candidate.closest(COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR));
};

export const reservesComputerKeyboardChord = (
  event: ComputerKeyboardEventState,
): boolean => (
  event.defaultPrevented
  || event.isComposing
  || event.altKey
  || event.ctrlKey
  || event.metaKey
);
