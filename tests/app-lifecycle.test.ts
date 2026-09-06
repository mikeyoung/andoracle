import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve("src/App.tsx"), "utf8");

const callbackBody = (start: string, end: string): string => {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return appSource.slice(startIndex, endIndex);
};

describe("App asynchronous teardown ownership", () => {
  it("single-flights external-input cancellation until power teardown settles", () => {
    const source = callbackBody(
      "const toggleExternalInput = useCallback",
      "const panic =",
    );

    expect(source).toContain("externalInputCancellationGuard.acquire()");
    expect(source).toContain("if (cancellationLease === null) return;");
    expect(source).toMatch(
      /try\s*\{[\s\S]*?await engine\.powerOff\(\);[\s\S]*?\}\s*finally\s*\{\s*externalInputCancellationGuard\.release\(cancellationLease\);/,
    );
  });

  it("single-flights MIDI cancellation until port teardown settles", () => {
    const source = callbackBody(
      "const toggleMidi = useCallback",
      "const refreshMidi = useCallback",
    );

    expect(source).toContain("midiCancellationGuard.acquire()");
    expect(source).toContain("if (cancellationLease === null) return;");
    expect(source).toMatch(
      /try\s*\{[\s\S]*?await midiSessionRef\.current\?\.disconnect\(\);[\s\S]*?\}\s*finally\s*\{\s*midiCancellationGuard\.release\(cancellationLease\);/,
    );
  });

  it("invalidates both cancellation leases during App cleanup", () => {
    const source = callbackBody(
      "mountedRef.current = true;",
      "const beforeInstall =",
    );

    expect(source).toContain("externalInputCancellationGuard.invalidate();");
    expect(source).toContain("midiCancellationGuard.invalidate();");
  });
});
