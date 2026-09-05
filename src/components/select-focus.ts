/** Tracks how a native selector was opened so keyboard browsing keeps focus. */
export type SelectInteractionModality = "keyboard" | "pointer";

/**
 * Pointer-picked options should return focus to the page for computer-note
 * input. Keyboard-picked options keep focus so the user can continue browsing.
 */
export const finishSelectChange = (
  select: Pick<HTMLSelectElement, "blur">,
  modality: SelectInteractionModality,
): boolean => {
  if (modality !== "pointer") return false;
  select.blur();
  return true;
};
