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
  return target ? '/chat?payment=' + target : Object.hasOwn(notices, kind) ? notices[kind].path : '/chat';
}
function paymentBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.amount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value.amount) || !/[1-9]/.test(value.amount) ||
      typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || (value.direction !== 'in' && value.direction !== 'out')) return null;
  const [whole, fraction = ''] = value.amount.split('.');
  const amount = (value.currency === 'GHS' ? 'GH₵' : value.currency + ' ') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.padEnd(2, '0');
  if (value.transfer !== undefined) {
    if (!value.transfer || typeof value.transfer !== 'object' || Array.isArray(value.transfer)) return null;
    const label = input => typeof input === 'string' && input.trim().length > 0 && input.trim().length <= 60 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input.trim()) ? input.trim() : null;
    const from = label(value.transfer.fromAccount), to = label(value.transfer.toAccount);
    return from && to ? 'Transfer · ' + amount + ' · ' + from + ' → ' + to + '.' : 'Transfer · ' + amount + ' between your accounts.';
  }
  return (value.direction === 'in' ? 'Money in · +' : 'Money out · −') + amount + '. Open Alfred to chat.';
}
async function clientResult(promise, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 1000); })]);
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  // Only the structured, server-selected preview is eligible for financial copy.
  // Arbitrary nested notification text and links remain ignored. Old payloads
  // without a structured preview keep the discreet copy.
  let kind = 'payment', targetId = null, payment = null;
  try {
    const supplied = event.data.json();
    if (typeof supplied.kind === 'string' && Object.hasOwn(notices, supplied.kind)) kind = supplied.kind;
    if (supplied.kind === 'payment') {
      targetId = paymentTarget(supplied.targetId);
      if (targetId) payment = paymentBody(supplied.payment);
    }
  } catch {}
  const notice = notices[kind];
  event.waitUntil(self.registration.showNotification('Alfred', {
    body: payment || notice.body, data: { kind, ...(targetId ? { targetId } : {}) },
    // A retry replaces this payment's notice, without replacing a different payment.
    ...(targetId ? { tag: 'alfred-payment-' + targetId } : kind !== 'payment' ? { tag: 'alfred-' + kind } : {}),
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const kind = event.notification.data?.kind;
  const target = noticePath(kind, event.notification.data?.targetId);
  event.waitUntil((async () => {
    const href = new URL(target, self.location.origin).href;
    let windows = [];
    // navigate() is only valid for a client controlled by this worker. In
    // particular, do not take over an unrelated, uncontrolled Safari tab.
    try { windows = await clientResult(self.clients.matchAll({ type: 'window' }), []); } catch {}
    const candidates = windows.filter(client => {
      try { return client.frameType !== 'nested' && new URL(client.url).origin === self.location.origin; } catch { return false; }
    });
    const existing = candidates.find(client => client.url === href) ||
      candidates.find(client => client.focused) ||
      candidates.find(client => client.visibilityState === 'visible') || candidates[0];
    if (existing) {
      // Bring the installed app forward while the notification tap still has
      // user activation. Waiting for network navigation first can leave a slow
      // or resumed app in the background until that navigation completes.
      let focused;
      try { focused = clientResult(Promise.resolve(existing.focus()).then(() => true, () => false), false); } catch { focused = Promise.resolve(false); }
      // A successful Chat reply clears its temporary payment binding while the
      // URL can remain unchanged. Re-enter payment links even at that URL so a
      // repeated tap restores the current source rather than an unrelated turn.
      if (existing.url === href && kind !== 'payment') {
        if (await focused) return;
      } else {
        try {
          const navigated = await existing.navigate(href);
          // A focus failure is not a navigation failure. Do not open a duplicate
          // window after the intended client has already navigated successfully.
          if (navigated) { await focused; return; }
        } catch {}
      }
    }
    return self.clients.openWindow(href);
  })());
});
