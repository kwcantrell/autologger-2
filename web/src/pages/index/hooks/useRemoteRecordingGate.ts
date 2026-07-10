import { useEffect, useRef } from 'react';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { getClientInstanceId } from '../../../shared/utils/clientId';
import { computeRemoteRecordingBlocksMedia } from '../../../shared/utils/recording';

const REMOTE_RECORDING_NOTICE =
  'This session is being recorded from another window, browser, or user. ' +
  'Playback, roll, record, and stop are disabled here so that session is not interrupted.\n\n' +
  'You can still use log buttons; timecode stays in sync with the session.\n\n' +
  'Use the location where recording started to control audio and transport.';

export function useRemoteRecordingGate(sessionId: string | null): boolean {
  const { data: status } = useSessionStatus(sessionId);
  const blocksMedia = computeRemoteRecordingBlocksMedia(status, getClientInstanceId());
  const previousBlocksRef = useRef(false);
  const noticeShownRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset refs on session switch
  useEffect(() => {
    noticeShownRef.current = false;
    previousBlocksRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (blocksMedia && !previousBlocksRef.current && !noticeShownRef.current) {
      noticeShownRef.current = true;
      window.alert(REMOTE_RECORDING_NOTICE);
    }
    previousBlocksRef.current = blocksMedia;
  }, [blocksMedia]);

  return blocksMedia;
}
