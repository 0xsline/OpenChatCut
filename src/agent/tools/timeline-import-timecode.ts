// SMPTE timecode labels for EDL import and for import reports.
//
// Drop-frame (29.97/59.94 DF) labels skip frame numbers 00 and 01 (00-03 at
// 59.94) at the start of every minute except each tenth minute, so a label is
// converted to a physical frame count before any arithmetic. A ';' separator
// marks a drop-frame label; CMX 3600 lists written with ':' only say so on
// their "FCM: DROP FRAME" line instead, which the EDL parser passes in.

export interface TimecodeLabel {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  /** The label itself used a ';' separator. */
  dropFrame: boolean;
}

const LABEL = /^(\d{1,2})([:;])(\d{2})([:;])(\d{2})([:;.,])(\d{2})$/;

export function parseTimecodeLabel(value: string): TimecodeLabel | null {
  const match = LABEL.exec(value.trim());
  if (!match) return null;
  return {
    hours: Number(match[1]),
    minutes: Number(match[3]),
    seconds: Number(match[5]),
    frames: Number(match[7]),
    dropFrame: [match[2], match[4], match[6]].includes(';'),
  };
}

export function dropFramesPerMinute(nominalFps: number): number | null {
  if (nominalFps === 30) return 2;
  if (nominalFps === 60) return 4;
  return null;
}

/** Physical frame count of a label, or null when the label cannot exist at that rate. */
export function labelToFrames(label: TimecodeLabel, nominalFps: number, dropFrame: boolean): number | null {
  const { hours, minutes, seconds, frames } = label;
  if (minutes > 59 || seconds > 59 || frames >= nominalFps) return null;
  const totalMinutes = hours * 60 + minutes;
  const nominalFrames = (totalMinutes * 60 + seconds) * nominalFps + frames;
  if (!dropFrame) return nominalFrames;
  const dropped = dropFramesPerMinute(nominalFps);
  if (dropped === null) return null;
  // Labels ;00/;01 of a non-tenth minute were never assigned to a frame.
  if (seconds === 0 && minutes % 10 !== 0 && frames < dropped) return null;
  return nominalFrames - dropped * (totalMinutes - Math.floor(totalMinutes / 10));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Physical frame count → display label (';' before the frames field when drop-frame). */
export function framesToLabel(totalFrames: number, nominalFps: number, dropFrame: boolean): string {
  let frames = Math.max(0, Math.round(totalFrames));
  const dropped = dropFrame ? dropFramesPerMinute(nominalFps) : null;
  if (dropped !== null) {
    const perTenMinutes = nominalFps * 600 - dropped * 9;
    const perMinute = nominalFps * 60 - dropped;
    const tens = Math.floor(frames / perTenMinutes);
    const remainder = frames % perTenMinutes;
    frames += dropped * 9 * tens + (remainder > dropped ? dropped * Math.floor((remainder - dropped) / perMinute) : 0);
  }
  const perHour = nominalFps * 3600;
  const hours = Math.floor(frames / perHour);
  const minutes = Math.floor((frames % perHour) / (nominalFps * 60));
  const seconds = Math.floor((frames % (nominalFps * 60)) / nominalFps);
  const frame = frames % nominalFps;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${dropped !== null ? ';' : ':'}${pad(frame)}`;
}

/** Frame count of the HH:00:00:00 label at or before `frames` (the start of its timecode hour). */
export function hourStartFrames(frames: number, nominalFps: number, dropFrame: boolean): number {
  const dropped = dropFrame ? dropFramesPerMinute(nominalFps) : null;
  // A drop-frame hour is six ten-minute blocks that each skip nine minutes' worth of labels.
  const perHour = dropped === null ? nominalFps * 3600 : 6 * (nominalFps * 600 - dropped * 9);
  return Math.floor(Math.max(0, frames) / perHour) * perHour;
}
