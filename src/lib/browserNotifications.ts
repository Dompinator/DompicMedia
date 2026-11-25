/** Desktop / mobile system notifications, shown while DompicMEDIA is open in a tab. */

const PREF_KEY = 'dompic_browser_notifications';

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserNotificationsEnabled(): boolean {
  if (!browserNotificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

function registerWorker(): void {
  // Android browsers only allow notifications through a service worker.
  navigator.serviceWorker?.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}

export async function enableBrowserNotifications(): Promise<string | null> {
  if (!browserNotificationsSupported()) {
    return 'This browser does not support notifications. On iPhone, add the site to your Home Screen first.';
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return 'Notifications are blocked. Allow them for this site in your browser settings.';
  }
  try {
    localStorage.setItem(PREF_KEY, 'true');
  } catch {
    return 'This browser would not save the preference.';
  }
  registerWorker();
  return null;
}

export function disableBrowserNotifications(): void {
  try {
    localStorage.setItem(PREF_KEY, 'false');
  } catch {
    // ignore storage restriction
  }
}

export async function showBrowserNotification(
  title: string,
  body: string,
  tag: string,
  onClick: () => void
): Promise<void> {
  if (!browserNotificationsEnabled()) return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
    await registration?.showNotification(title, { body, tag });
  }
}
