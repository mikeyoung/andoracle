/**
 * Versioned migration bridge for Andoracle 1.0.23's automatic update path.
 * transition. Remove this import and file in a later release once pre-1.0.18
 * prompt workers have been replaced.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    let windowClients = [];
    try {
      // Updated workers inherit the previous worker's controlled clients
      // before `activate` runs. A first-install page is still uncontrolled.
      // Snapshot before claim() so only migrations, not fresh installs, reload.
      windowClients = await self.clients.matchAll({ type: "window" });
    } catch {
      // Client enumeration is best-effort. Still claim the app below.
    }

    let claim = Promise.resolve();
    try {
      claim = Promise.resolve(self.clients.claim()).catch(() => undefined);
    } catch {
      // A shutdown race can make claim() throw synchronously.
    }

    let scopeUrl;
    try {
      scopeUrl = new URL(self.registration.scope);
    } catch {
      await claim;
      return;
    }

    for (const client of windowClients) {
      try {
        const clientUrl = new URL(client.url);
        if (
          clientUrl.origin !== scopeUrl.origin
          || !clientUrl.href.startsWith(scopeUrl.href)
          || typeof client.navigate !== "function"
        ) {
          continue;
        }
        // Starting the navigation is sufficient. Never extend activation with
        // a browser-owned navigation promise that may outlive a closing tab.
        void Promise.resolve(client.navigate(client.url)).catch(() => undefined);
      } catch {
        // A client may close or navigate between enumeration and this call.
      }
    }

    await claim;
  })());
});
