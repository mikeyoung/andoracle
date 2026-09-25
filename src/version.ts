/**
 * Andoracle release identifier.
 *
 * Bump via `npm run release -- <version>`, which keeps this constant in
 * lockstep with package.json, its lockfile, and the versioned PWA update
 * bridge. Build metadata, install manifests, and browser-store packages are
 * verified against it.
 */
export const ANDORACLE_VERSION = "1.0.25" as const;
