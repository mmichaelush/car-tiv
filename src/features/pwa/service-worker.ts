/**
 * Registering the service worker, and telling the visitor when a new version
 * is ready.
 *
 * Two things this deliberately does not do:
 *
 *  * **It does not reload the page by itself.** A page that reloads under
 *    someone's hands loses what they were reading and any text they had typed.
 *    A new version waits, a toast offers it, and the visitor decides.
 *  * **It does not register in development.** A service worker that caches a
 *    dev build is a memorable afternoon of debugging the wrong file; any
 *    previously installed worker is actively removed there instead.
 */

import { toast } from '../../ui/components/toast.js';

const SCRIPT_URL = '/sw.js';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  if (isDevelopmentHost()) {
    void unregisterAll();
    return;
  }

  // After load, not during it: registration competes with the page's own
  // requests, and nothing on screen is waiting for it.
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(SCRIPT_URL, { scope: '/' })
      .then(watchForUpdates)
      .catch(() => {
        // Unsupported, blocked by a policy, or served over plain HTTP. The
        // site works exactly as before without it.
      });
  });
}

/** Offer the update once a new worker has finished installing. */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  const offer = (worker: ServiceWorker): void => {
    toast('גרסה חדשה של האתר מוכנה', {
      // Stays until the visitor answers: an update they never saw offered is
      // an update that never happens.
      durationMs: 0,
      action: {
        label: 'רענון',
        onSelect: () => {
          worker.postMessage('skip-waiting');
        },
      },
    });
  };

  // Already waiting when the page loaded — a second tab installed it.
  if (registration.waiting != null && navigator.serviceWorker.controller != null) {
    offer(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (installing == null) return;

    installing.addEventListener('statechange', () => {
      // `controller != null` distinguishes an update from the very first
      // install, where there is nothing to tell the visitor about.
      if (installing.state === 'installed' && navigator.serviceWorker.controller != null) {
        offer(installing);
      }
    });
  });

  // The new worker took over: now a reload is safe and expected.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function isDevelopmentHost(): boolean {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
}

async function unregisterAll(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  for (const registration of registrations) await registration.unregister();
}
