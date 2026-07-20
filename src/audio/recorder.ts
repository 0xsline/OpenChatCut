import { useCallback, useRef, useState } from 'react';
import { t } from '../i18n/locale';

// Microphone voiceover recorder used by the toolbar.
// getUserMedia(audio) → MediaRecorder → one Blob on stop, handed to onComplete
// (which uploads it + drops it on an audio track). Voiceover only —
// camera/screen record modes are out of scope.

export interface Recorder {
  recording: boolean;
  error: string | null;
  toggle: () => void;
}

export function useRecorder(onComplete: (blob: Blob) => void): Recorder {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t('此浏览器不支持录音'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size) onCompleteRef.current(blob);
        setRecording(false);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error && e.name === 'NotAllowedError' ? t('麦克风权限被拒绝') : t('无法访问麦克风'));
      setRecording(false);
    }
  }, []);

  const stop = useCallback(() => recRef.current?.stop(), []);
  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { recording, error, toggle };
}
