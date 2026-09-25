/**
 * Browser-store version rules for Andoracle.
 *
 * Kept dependency-free so both the extension packager (plain Node) and
 * vite.config.ts (typechecked, fail-fast at config load) can share one
 * canonical implementation: the stores accept one to four dot-separated
 * integers, with no leading zeroes and each component 0–65535.
 */
export const extensionStoreVersion = (version) => {
  if (typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error("Extension builds require package.json version to contain one to four dot-separated integers.");
  }
  const components = version.split(".");
  if (components.some((component) => component.length > 1 && component.startsWith("0"))) {
    throw new Error("Non-zero extension version components cannot have leading zeroes.");
  }
  const parts = components.map(Number);
  if (parts.every((part) => part === 0) || parts.some((part) => !Number.isSafeInteger(part) || part > 65535)) {
    throw new Error("Extension version components must be 0–65535 and the complete version cannot be zero.");
  }
  return version;
};
