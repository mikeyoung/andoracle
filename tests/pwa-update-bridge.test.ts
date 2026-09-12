import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PWA_INJECT_REGISTER,
  PWA_WORKBOX_CLIENTS_CLAIM,
  PWA_WORKBOX_IMPORT_SCRIPTS,
} from "../vite.config";

interface ActivateEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

type ActivateListener = (event: ActivateEventLike) => void;

describe("PWA 1.0.24 update bridge", () => {
  it("claims clients before reloading only same-origin windows inside the app scope", async () => {
    const bridgeName = "sw-update-bridge-1.0.24.js";
    expect(PWA_WORKBOX_IMPORT_SCRIPTS).toEqual([bridgeName]);
    expect(PWA_WORKBOX_CLIENTS_CLAIM).toBe(false);
    expect(PWA_INJECT_REGISTER).toBe(false);

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
    });
    expect(inScope.navigate).toHaveBeenCalledExactlyOnceWith(inScope.url);
    expect(closingInScope.navigate).toHaveBeenCalledExactlyOnceWith(closingInScope.url);
    expect(synchronousFailureInScope.navigate)
      .toHaveBeenCalledExactlyOnceWith(synchronousFailureInScope.url);
    expect(adjacentPath.navigate).not.toHaveBeenCalled();
    expect(otherOrigin.navigate).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["match", "claim"]);
  });

  it("reloads prior controlled clients but not a fresh-install page", async () => {
    const bridgeName = "sw-update-bridge-1.0.24.js";
    const previousWorker = { version: "1.0.17" };
    const activatingWorker = { version: "1.0.24" };
    const updateClient = {
      url: "https://mikeyoung.org/andoracle/?from=1.0.17",
      navigate: vi.fn(async () => null),
    };
    const freshClient = {
      url: "https://mikeyoung.org/andoracle/",
      navigate: vi.fn(async () => null),
    };
    const clients = [
      { activeWorker: previousWorker as object | null, windowClient: updateClient },
      { activeWorker: null as object | null, windowClient: freshClient },
    ];

    // Service Workers Activate step 8 transfers only clients already using
    // this registration from the previous worker to the activating worker,
    // before the activate event is dispatched. A first-install client stays
    // uncontrolled until Clients.claim().
    for (const client of clients) {
      if (client.activeWorker === previousWorker) client.activeWorker = activatingWorker;
    }

    const matchAll = vi.fn(async (options: { type: string }) => {
      expect(options).toEqual({ type: "window" });
      // Clients.matchAll defaults includeUncontrolled to false.
      return clients
        .filter((client) => client.activeWorker === activatingWorker)
        .map((client) => client.windowClient);
    });
    const claim = vi.fn(async () => {
      for (const client of clients) client.activeWorker = activatingWorker;
    });
    let activate: ActivateListener | undefined;

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
    activate?.({ waitUntil: (promise) => { activation = promise; } });
    if (!activation) throw new Error("The update bridge did not extend activation.");
    await expect(activation).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(updateClient.navigate).toHaveBeenCalledExactlyOnceWith(updateClient.url);
    expect(freshClient.navigate).not.toHaveBeenCalled();
    expect(clients.every((client) => client.activeWorker === activatingWorker)).toBe(true);
  });

  it("does not keep activation pending on a never-settling client navigation", async () => {
    const bridgeName = "sw-update-bridge-1.0.24.js";
    const neverSettles = new Promise<null>(() => undefined);
    const client = {
      url: "https://mikeyoung.org/andoracle/",
      navigate: vi.fn(() => neverSettles),
    };
    let activate: ActivateListener | undefined;

    runInNewContext(
      readFileSync(resolve("public", bridgeName), "utf8"),
      {
        URL,
        Promise,
        self: {
          registration: { scope: "https://mikeyoung.org/andoracle/" },
          clients: {
            claim: vi.fn(async () => undefined),
            matchAll: vi.fn(async () => [client]),
          },
          addEventListener: (_type: string, listener: ActivateListener) => {
            activate = listener;
          },
        },
      },
    );

    let activation: Promise<unknown> | undefined;
    activate?.({ waitUntil: (promise) => { activation = promise; } });
    if (!activation) throw new Error("The update bridge did not extend activation.");
    await expect(activation).resolves.toBeUndefined();
    expect(client.navigate).toHaveBeenCalledExactlyOnceWith(client.url);
  });

  it.each(["claim", "matchAll"] as const)(
    "contains a rejected %s operation so activation still completes",
    async (failedOperation) => {
      const bridgeName = "sw-update-bridge-1.0.24.js";
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
      expect(matchAll).toHaveBeenCalledTimes(1);
    },
  );
});
