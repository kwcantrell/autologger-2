import { useCallback, useState } from 'react';
import {
  readSessionLayoutPreference,
  type SessionLayoutPreference,
  writeSessionLayoutPreference,
} from '../utils/sessionLayoutPreference';

export function useSessionLayoutPreference() {
  const [preference, setPreferenceState] = useState<SessionLayoutPreference>(() =>
    readSessionLayoutPreference(),
  );

  const setPreference = useCallback((value: SessionLayoutPreference) => {
    writeSessionLayoutPreference(value);
    setPreferenceState(value);
  }, []);

  return { preference, setPreference };
}
