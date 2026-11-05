import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function videoToolsAvailable() {
  return ['ffmpeg', 'ffprobe'].every(
    (command) =>
      spawnSync(command, ['-version'], { timeout: 5000, stdio: 'ignore', windowsHide: true })
        .status === 0,
  );
}

export function testVideo(codec = 'libx264', withAudio = false) {
  const dir = mkdtempSync(join(process.env.XHIMG_TEST_TMPDIR ?? tmpdir(), 'xhimg-video-fixture-'));
  try {
    const path = join(dir, 'sample.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=12',
        ...(withAudio
          ? ['-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=44100', '-c:a', 'aac']
          : []),
        '-t',
        '3',
        '-c:v',
        codec,
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-g',
        '12',
        '-movflags',
        '+faststart',
        path,
      ],
      { timeout: 15_000, windowsHide: true },
    );
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
