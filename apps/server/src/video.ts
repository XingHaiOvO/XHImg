import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fail } from './security.js';

const run = promisify(execFile);
// The MOV demuxer handles MP4. Disable external data references and network protocols.
const inputOptions = [
  '-protocol_whitelist',
  'file,pipe',
  '-enable_drefs',
  '0',
  '-use_absolute_path',
  '0',
  '-max_alloc',
  String(128 * 1024 ** 2),
  '-f',
  'mov',
];
let encoderAvailable = false;

async function videoTool(command: string, args: string[], timeout: number) {
  try {
    return await run(command, args, {
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail(503, 'VIDEO_TOOLS_UNAVAILABLE', '视频上传和封面需要 FFmpeg 与 FFprobe');
    fail(400, 'INVALID_VIDEO', '无法读取视频，文件可能损坏或超出处理限制');
  }
}

export async function inspectMp4(path: string) {
  const header = Buffer.alloc(4096);
  const file = await open(path, 'r');
  try {
    const { bytesRead } = await file.read(header);
    const size = header.readUInt32BE(0);
    const major = header.toString('ascii', 8, 12);
    const mp4Brand = /^(?:iso[m2-9]|mp4[12]|avc1|M4V )$/;
    let compatible = mp4Brand.test(major);
    for (let offset = 16; !compatible && offset + 4 <= size && offset + 4 <= bytesRead; offset += 4)
      compatible = mp4Brand.test(header.toString('ascii', offset, offset + 4));
    if (
      size < 16 ||
      size > bytesRead ||
      header.toString('ascii', 4, 8) !== 'ftyp' ||
      major === 'qt  ' ||
      !compatible
    )
      fail(415, 'UNSUPPORTED_VIDEO_FORMAT', '仅支持 MP4 视频');
  } finally {
    await file.close();
  }
  const { stdout } = await videoTool(
    'ffprobe',
    [
      '-v',
      'error',
      ...inputOptions,
      '-show_entries',
      'stream=codec_type,codec_name,pix_fmt,width,height:stream_disposition=attached_pic:stream_side_data=rotation:format=duration',
      '-of',
      'json',
      '-i',
      path,
    ],
    15_000,
  );
  const { streams = [], format } = JSON.parse(stdout) as {
    streams?: {
      codec_type: string;
      codec_name: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string };
  };
  const video = streams.filter(
    (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const track = video[0];
  if (
    video.length !== 1 ||
    track?.codec_name !== 'h264' ||
    !['yuv420p', 'yuvj420p'].includes(track.pix_fmt ?? '') ||
    audio.some((stream) => stream.codec_name !== 'aac')
  )
    fail(415, 'UNSUPPORTED_VIDEO_CODEC', 'MP4 需要 8 位 4:2:0 H.264 视频和 AAC 音轨（可无音轨）');
  const { width = 0, height = 0 } = track;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > 4096 ||
    Math.min(width, height) > 2160
  )
    fail(400, 'INVALID_VIDEO', '视频分辨率最高为 4096×2160，支持横屏和竖屏');
  const duration = Number(format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail(400, 'INVALID_VIDEO', '视频时长无效');
  if (!encoderAvailable) {
    await videoTool('ffmpeg', ['-version'], 5_000);
    encoderAvailable = true;
  }
  const rotation = track.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0;
  const rotated = Math.abs(rotation % 180) === 90;
  return {
    format: 'mp4',
    mime: 'video/mp4',
    width: rotated ? height : width,
    height: rotated ? width : height,
  };
}

export async function videoPoster(path: string, output: string) {
  await videoTool(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      ...inputOptions,
      '-threads',
      '1',
      '-i',
      path,
      '-map',
      '0:V:0',
      '-frames:v',
      '1',
      '-an',
      '-filter_threads',
      '1',
      '-vf',
      'scale=w=min(640\\,iw):h=min(640\\,ih):force_original_aspect_ratio=decrease',
      '-c:v',
      'libwebp',
      '-threads',
      '1',
      '-quality',
      '80',
      output,
    ],
    30_000,
  );
}
