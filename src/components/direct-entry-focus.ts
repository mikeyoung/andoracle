export type DirectEntryInteractionModality = "keyboard" | "pointer" | "unknown";

/**
 * Pointer-opened range editors return to the playable surface; keyboard-opened
 * editors return to the range so accessible keyboard adjustment can continue.
 */
export const shouldRestoreDirectEntryOrigin = (
  origin: Pick<HTMLElement, "matches">,
  modality: DirectEntryInteractionModality = "unknown",
): boolean => {
  if (!origin.matches('input[type="range"]')) return true;
  if (modality === "pointer") return false;
  if (modality === "keyboard") return true;
  try {
    return origin.matches(":focus-visible");
  } catch {
    // Older engines may reject :focus-visible in matches(). Releasing an
    // unknown range is safer than trapping computer-note input on it.
    return false;
  }
};
