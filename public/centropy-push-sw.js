/* B8.T1: keep this root-scoped so a push can open the exact approval even when the
   page is closed. No data is stored here; the server sends only a title/body/path. */
self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(payload.title || "CENTROPY", {
    body: payload.body || "An update needs your attention.",
    data: { path: typeof payload.path === "string" ? payload.path : "/centropy" },
    icon: "/favicon.ico",
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.path));
});
