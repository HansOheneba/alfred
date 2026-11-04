'use strict';
// Push-only worker. No fetch handler, authenticated response cache or offline data.
const notices = {
  payment: { body: 'There’s a private update for you. Open Alfred to review.', path: '/chat' },
  bill: { body: 'A private reminder is ready. Open Alfred to review.', path: '/dashboard' },
  weekly: { body: 'Your private overview is ready. Open Alfred to review.', path: '/dashboard' },
  test: { body: 'This is a test notification from Alfred.', path: '/settings' },
};
function paymentTarget(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : null;
}
function noticePath(kind, targetId) {
  const target = kind === 'payment' ? paymentTarget(targetId) : null;
  return target ? '/accounts?payment=' + target : Object.hasOwn(notices, kind) ? notices[kind].path : '/chat';
}
self.addEventListener('push', event => {
  // Ignore caller-provided financial text and links, including nested notification fields.
  let kind = 'payment', targetId = null;
  try {
    const supplied = event.data.json();
    if (typeof supplied.kind === 'string' && Object.hasOwn(notices, supplied.kind)) kind = supplied.kind;
    if (supplied.kind === 'payment') targetId = paymentTarget(supplied.targetId);
  } catch {}
  const notice = notices[kind];
  event.waitUntil(self.registration.showNotification('Alfred', {
    body: notice.body, data: { kind, ...(targetId ? { targetId } : {}) },
    // A retry replaces this payment's notice, without replacing a different payment.
    ...(targetId ? { tag: 'alfred-payment-' + targetId } : kind !== 'payment' ? { tag: 'alfred-' + kind } : {}),
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const kind = event.notification.data?.kind;
  const target = noticePath(kind, event.notification.data?.targetId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } });
    if (existing) {
      try { const navigated = await existing.navigate(new URL(target, self.location.origin).href); if (navigated) return navigated.focus(); } catch {}
    }
    return self.clients.openWindow(new URL(target, self.location.origin).href);
  })());
});
