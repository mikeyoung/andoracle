/**
 * One-release migration bridge for Andoracle 1.0.18's prompt-to-auto-update
 * transition. Remove this import and file in a later release once pre-1.0.18
 * prompt workers have been replaced.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      await self.clients.claim();
      const scopeUrl = new URL(self.registration.scope);
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      await Promise.allSettled(windowClients.map(async (client) => {
        const clientUrl = new URL(client.url);
        if (
          clientUrl.origin !== scopeUrl.origin
          || !clientUrl.href.startsWith(scopeUrl.href)
          || typeof client.navigate !== "function"
        ) {
          return;
        }
        await client.navigate(client.url);
      }));
    } catch {
      // Claiming or enumerating clients can fail in a browser shutdown race.
      // Never let the temporary migration bridge prevent worker activation.
    }
  })());
});
