export function createLiveChannel(channelName) {
  try {
    if ('BroadcastChannel' in window) {
      return new BroadcastChannel(channelName);
    }
  } catch {
    // BroadcastChannel may be unavailable on some file:// setups.
  }
  return null;
}

export function buildLivePayload(source, message) {
  return {
    version: 1,
    source,
    ts: Date.now(),
    nonce: Math.random().toString(36).slice(2),
    ...message
  };
}

export function publishLiveUpdate(channel, storageKey, payload) {
  try {
    channel?.postMessage(payload);
  } catch {
    // BroadcastChannel is best-effort.
  }

  try {
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // localStorage is only a fallback transport.
  }
}

export function rememberLiveMessage(seen, payload, limit = 80) {
  if (!payload?.nonce) return false;
  if (seen.has(payload.nonce)) return true;

  seen.add(payload.nonce);
  if (seen.size > limit) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  return false;
}

export function subscribeLiveUpdates(channelName, storageKey, onMessage) {
  const channel = createLiveChannel(channelName);
  channel?.addEventListener('message', event => {
    onMessage(event.data);
  });

  window.addEventListener('storage', event => {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      onMessage(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed fallback messages.
    }
  });

  return channel;
}
