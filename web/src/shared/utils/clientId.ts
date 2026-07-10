const SESSION_KEY = 'autologger:clientInstanceId';

export function getClientInstanceId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `cid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return `cid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
