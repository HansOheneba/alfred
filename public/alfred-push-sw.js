'use strict';
// Push-only worker. No fetch handler, authenticated response cache or offline data.
const notices = {
  payment: { body: 'There’s a private update for you. Open Alfred to review.', path: '/chat' },
  bill: { body: 'A private reminder is ready. Open Alfred to review.', path: '/dashboard' },
  weekly: { body: 'Your private overview is ready. Open Alfred to review.', path: '/dashboard' },
};
self.addEventListener('push', event => {
  // Ignore caller-provided financial text and links, including nested notification fields.
  let kind = 'payment';
  try { const supplied = event.data.json().kind; if (Object.hasOwn(notices, supplied)) kind = supplied; } catch {}
  const notice = notices[kind];
  event.waitUntil(self.registration.showNotification('Alfred', {
    body: notice.body, data: { kind }, tag: 'alfred-' + kind,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const kind = event.notification.data?.kind;
  const target = Object.hasOwn(notices, kind) ? notices[kind].path : '/chat';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } });
    if (existing) {
      try { const navigated = await existing.navigate(new URL(target, self.location.origin).href); if (navigated) return navigated.focus(); } catch {}
    }
    return self.clients.openWindow(new URL(target, self.location.origin).href);
  })());
});
