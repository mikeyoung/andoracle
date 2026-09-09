import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PWA_WORKBOX_IMPORT_SCRIPTS } from "../vite.config";

interface ActivateEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

type ActivateListener = (event: ActivateEventLike) => void;

describe("PWA 1.0.18 update bridge", () => {
  it("claims clients before reloading only same-origin windows inside the app scope", async () => {
    const bridgeName = "sw-update-bridge-1.0.18.js";
    expect(PWA_WORKBOX_IMPORT_SCRIPTS).toEqual([bridgeName]);

    const order: string[] = [];
    const inScope = {
      url: "https://mikeyoung.org/andoracle/?patch=saved#keyboard",
      navigate: vi.fn(async (url: string) => {
        order.push(`navigate:${url}`);
        return null;
      }),
    };
    const closingInScope = {
      url: "https://mikeyoung.org/andoracle/performance",
      navigate: vi.fn(async (url: string) => {
        order.push(`navigate:${url}`);
        throw new Error("client closed");
      }),
    };
    const synchronousFailureInScope = {
      url: "https://mikeyoung.org/andoracle/sequencer",
      navigate: vi.fn((url: string) => {
        order.push(`navigate:${url}`);
        throw new Error("navigation unavailable");
      }),
    };
    const missingNavigateInScope = {
      url: "https://mikeyoung.org/andoracle/legacy",
    };
    const adjacentPath = {
      url: "https://mikeyoung.org/andoracle-archive/",
      navigate: vi.fn(async () => null),
    };
    const otherOrigin = {
      url: "https://example.com/andoracle/",
      navigate: vi.fn(async () => null),
    };
    const claim = vi.fn(async () => {
      order.push("claim");
    });
    const matchAll = vi.fn(async () => {
      order.push("match");
      return [
        inScope,
        closingInScope,
        synchronousFailureInScope,
        missingNavigateInScope,
        adjacentPath,
        otherOrigin,
      ];
    });
    let activate: ActivateListener | undefined;
    const addEventListener = vi.fn((type: string, listener: ActivateListener) => {
      expect(type).toBe("activate");
      activate = listener;
    });

    runInNewContext(
      readFileSync(resolve("public", bridgeName), "utf8"),
      {
        URL,
        Promise,
        self: {
          registration: { scope: "https://mikeyoung.org/andoracle/" },
          clients: { claim, matchAll },
          addEventListener,
        },
      },
    );
    expect(activate).toBeTypeOf("function");

    let activation: Promise<unknown> | undefined;
    activate?.({
      waitUntil(promise) {
        activation = promise;
      },
    });
    if (!activation) throw new Error("The update bridge did not extend activation.");
    await expect(activation).resolves.toBeUndefined();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledExactlyOnceWith({
      type: "window",
      includeUncontrolled: true,
    });
    expect(inScope.navigate).toHaveBeenCalledExactlyOnceWith(inScope.url);
    expect(closingInScope.navigate).toHaveBeenCalledExactlyOnceWith(closingInScope.url);
    expect(synchronousFailureInScope.navigate)
      .toHaveBeenCalledExactlyOnceWith(synchronousFailureInScope.url);
    expect(adjacentPath.navigate).not.toHaveBeenCalled();
    expect(otherOrigin.navigate).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["claim", "match"]);
  });

  it.each(["claim", "matchAll"] as const)(
    "contains a rejected %s operation so activation still completes",
    async (failedOperation) => {
      const bridgeName = "sw-update-bridge-1.0.18.js";
      let activate: ActivateListener | undefined;
      const claim = vi.fn(async () => {
        if (failedOperation === "claim") throw new Error("claim unavailable");
      });
      const matchAll = vi.fn(async () => {
        if (failedOperation === "matchAll") throw new Error("enumeration unavailable");
        return [];
      });

      runInNewContext(
        readFileSync(resolve("public", bridgeName), "utf8"),
        {
          URL,
          Promise,
          self: {
            registration: { scope: "https://mikeyoung.org/andoracle/" },
            clients: { claim, matchAll },
            addEventListener: (_type: string, listener: ActivateListener) => {
              activate = listener;
            },
          },
        },
      );

      let activation: Promise<unknown> | undefined;
      activate?.({
        waitUntil(promise) {
          activation = promise;
        },
      });
      if (!activation) throw new Error("The update bridge did not extend activation.");
      await expect(activation).resolves.toBeUndefined();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(matchAll).toHaveBeenCalledTimes(failedOperation === "claim" ? 0 : 1);
    },
  );
});
