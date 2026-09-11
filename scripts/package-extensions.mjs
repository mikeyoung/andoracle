import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageExtensions } from "./extension-package-utils.mjs";

export const buildStorePackages = () => {
  const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  return packageExtensions(packageMetadata);
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = buildStorePackages();
    for (const entry of result.packages) {
      console.log(`Created ${entry.target} store package: ${entry.archivePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
