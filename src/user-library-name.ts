/** Maximum persisted display length for a user-named patch or sequence. */
export const USER_LIBRARY_NAME_MAX_LENGTH = 33;

/**
 * Mirrors the HTML text-input maxlength definition so UI and storage enforce
 * exactly the same boundary, including for programmatic save calls.
 */
export const isUserLibraryNameWithinLimit = (name: string): boolean =>
  name.length <= USER_LIBRARY_NAME_MAX_LENGTH;

const sliceWithoutSplittingSurrogatePair = (
  value: string,
  maximumLength: number,
): string => {
  const sliced = value.slice(0, maximumLength);
  if (sliced.length === 0) return sliced;
  const finalCodeUnit = sliced.charCodeAt(sliced.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? sliced.slice(0, -1)
    : sliced;
};

/**
 * Applies the same UTF-16 limit as an HTML maxlength field without ever
 * returning half of a surrogate pair. This also protects controlled inputs
 * from programmatic input events that bypass the browser's native maxlength
 * enforcement.
 */
export const truncateUserLibraryName = (value: string): string =>
  sliceWithoutSplittingSurrogatePair(value, USER_LIBRARY_NAME_MAX_LENGTH);

/**
 * Fits a normalized historical name and an allocator suffix within the same
 * UTF-16 boundary enforced by an HTML maxlength field. Trimming the cut edge
 * keeps every migrated result canonical for display and duplicate matching.
 */
export const fitUserLibraryNameWithSuffix = (
  normalizedName: string,
  suffix: string,
): string => {
  const availableNameLength = Math.max(0, USER_LIBRARY_NAME_MAX_LENGTH - suffix.length);
  const fittedName = sliceWithoutSplittingSurrogatePair(
    normalizedName,
    availableNameLength,
  ).trimEnd();
  return `${fittedName}${suffix}`;
};

/**
 * Deterministically migrates an over-limit historical name. Existing canonical
 * names can be pre-reserved so a truncated legacy name never steals one.
 */
export const allocateUserLibraryName = (
  normalizedName: string,
  allocatedNameKeys: ReadonlySet<string>,
  nameKey: (name: string) => string,
  isForbidden: (name: string) => boolean = () => false,
): string => {
  for (let sequence = 1; ; sequence += 1) {
    const suffix = sequence === 1 ? "" : ` (${sequence})`;
    const candidate = fitUserLibraryNameWithSuffix(normalizedName, suffix);
    if (candidate && !isForbidden(candidate) && !allocatedNameKeys.has(nameKey(candidate))) {
      return candidate;
    }
  }
};
