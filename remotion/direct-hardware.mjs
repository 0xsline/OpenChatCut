import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_ERROR_OUTPUT = 32_768;

function ffmpegPath(binariesDirectory) {
  return path.join(binariesDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function remuxHardwareOutputToAac({ input, output, binariesDirectory, signal }) {
  const args = [
    '-hide_banner', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k',
    '-movflags', '+faststart', output,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(binariesDirectory), args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_ERROR_OUTPUT); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hardware encoder finalization failed (${code ?? 'unknown'}): ${stderr}`));
    });
  });
}

/** Keep Remotion's custom hardware video pass fast, then normalize MP3 audio to standard AAC. */
export async function renderDirectHardware({ render, options, binariesDirectory, signal }) {
  const output = options.outputLocation;
  if (!output) return render(options);
  const intermediate = `${output}.direct-hardware.mp4`;
  try {
    const result = await render({
      ...options,
      outputLocation: intermediate,
      binariesDirectory,
      audioCodec: 'mp3',
    });
    await remuxHardwareOutputToAac({ input: intermediate, output, binariesDirectory, signal });
    return result;
  } finally {
    await rm(intermediate, { force: true }).catch(() => {});
  }
}
