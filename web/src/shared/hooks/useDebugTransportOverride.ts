import { useSyncExternalStore } from 'react';
import {
  DEBUG_SESSION_TRANSPORT_EVENT,
  type DebugSessionTransport,
  getDebugSessionTransportOverride,
} from '../utils/perfDebug';

export type DebugTransportOverride = DebugSessionTransport | null;

function subscribe(cb: () => void): () => void {
  window.addEventListener(DEBUG_SESSION_TRANSPORT_EVENT, cb);
  return () => window.removeEventListener(DEBUG_SESSION_TRANSPORT_EVENT, cb);
}

export function useDebugTransportOverride(): DebugTransportOverride {
  return useSyncExternalStore(subscribe, getDebugSessionTransportOverride, () => null);
}
