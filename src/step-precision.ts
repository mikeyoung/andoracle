/*
 * Parameter steps come from Andoracle's finite, static control schemas. Cache
 * their decimal precision once so pointer-rate normalization and the trailing
 * patch-URL encoder do not repeatedly allocate temporary strings.
 */
const STEP_PRECISION_CACHE = new Map<number, number>();

export const decimalPlacesForStep = (step: number): number => {
  const cached = STEP_PRECISION_CACHE.get(step);
  if (cached !== undefined) return cached;

  const stringValue = step.toString().toLowerCase();
  const [coefficient, exponentText] = stringValue.split("e");
  const coefficientPrecision = coefficient.includes(".")
    ? coefficient.split(".")[1].length
    : 0;
  const precision = exponentText === undefined
    ? coefficientPrecision
    : Math.max(0, coefficientPrecision - Number(exponentText));
  STEP_PRECISION_CACHE.set(step, precision);
  return precision;
};
