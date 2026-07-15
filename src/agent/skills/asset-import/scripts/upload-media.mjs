#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const MAX_DIMENSION = 1920;
const SKIP_MAX_SOURCE_BITRATE_BPS = 8_000_000;
const TARGET_PEAK_BITRATE_BPS = 8_000_000;
const TARGET_FLOOR_BITRATE_BPS = 1_500_000;
const REFERENCE_PIXELS = 1920 * 1080;
const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_QUALITY = 3;
const VIDEO_AUDIO_BITRATE = "320k";
const AUDIO_ASSET_BITRATE = "128k";
const TRANSCRIPTION_AUDIO_BITRATE = "64k";
const TRANSCRIPTION_SILENCE_MAX_VOLUME_DB = -60;
const PROBE_TIMEOUT_MS = 10_000;
const LOUDNESS_PROBE_TIMEOUT_MS = 120_000;
const MULTIPART_SIGN_BATCH_SIZE = 32;
const UPLOAD_RETRY_MAX_ATTEMPTS = 5;
const UPLOAD_RETRY_ATTEMPT_TIMEOUT_MS = 120_000;
const EXTRACTED_AUDIO_FORMATS = {
  ogg: {
    contentType: "audio/ogg",
    extension: ".ogg",
    filename: "extracted-audio.ogg",
  },
};
const OGG_PACKET_COPY_CODECS = new Set(["opus", "vorbis"]);
const BUNDLED_FFMPEG_VERSION = "8.1";
const BUNDLED_MEDIA_TOOLS = {
  "darwin-arm64": {
    ffmpeg: {
      filename: "ffmpeg",
      sha256:
        "9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028",
    },
    ffprobe: {
      filename: "ffprobe",
      sha256:
        "aab17ac7379c1178aaf400c3ef36cdb67db0b75b1a23eeef2cb9f658be8844e6",
    },
  },
  "win32-x64": {
    ffmpeg: {
      filename: "ffmpeg.exe",
      sha256:
        "1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e",
    },
    ffprobe: {
      filename: "ffprobe.exe",
      sha256:
        "b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07",
    },
  },
};

const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  process.stderr.write(`Usage:
  node <path-to-upload-media.mjs> --token <token> --endpoint <url> <file> [file...] [--background]
  node <path-to-upload-media.mjs> --token <token> --endpoint <url> --input <file> [--input <file>...] [--json-out <result.json>] [--background]
  node <path-to-upload-media.mjs> --token <token> --endpoint <url> --background <file> [file...]
  node <path-to-upload-media.mjs> --token <token> --endpoint <url> --asset-id <assetId> <file>
  node <path-to-upload-media.mjs> --token <token> --endpoint <url> --transcription-only --asset-id <assetId> <file>

Get the token once from import_media action=create_session, then pass all
readable media files to this script. Files run in parallel. Non-SVG assets are
registered before expensive conversion; transcription audio is uploaded and
started before asset transcode/upload; the final asset upload slot is requested
only after transcode so the presigned URL uses the actual prepared file size.

Requires Node.js 18+, ffmpeg, and ffprobe.
`);
}

function fail(message) {
  throw new Error(message);
}

function logProgress(message) {
  process.stderr.write(`[chatcut-upload] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  const seconds =
    Math.min(16, 2 ** (attempt - 1)) + Math.floor(Math.random() * 2);
  return seconds * 1000;
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    UPLOAD_RETRY_ATTEMPT_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(
        `request timed out after ${UPLOAD_RETRY_ATTEMPT_TIMEOUT_MS / 1000}s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const options = {
    background: false,
    backgroundWorker: false,
    curlCompat: false,
    endpoint: process.env.CHATCUT_MEDIA_IMPORT_ENDPOINT || "",
    ffmpeg: process.env.FFMPEG_PATH || "",
    ffprobe: process.env.FFPROBE_PATH || "",
    inputs: [],
    jsonOut: "",
    resumeAssetId: "",
    sessionToken: "",
    transcribe: true,
    transcriptionOnly: false,
    workDir: process.env.TMPDIR || tmpdir(),
    workerIndex: 0,
    workerLogFile: "",
    workerPlanFile: "",
    workerSourceFile: "",
    workerStatusFile: "",
  };

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) fail(`${arg} requires a value.`);
      index += 2;
      return value;
    };
    switch (arg) {
      case "--input":
        options.inputs.push(next());
        break;
      case "--token":
      case "--session-token":
      case "--import-token":
        options.sessionToken = next();
        break;
      case "--endpoint":
        options.endpoint = next();
        break;
      case "--json-out":
        options.jsonOut = next();
        break;
      case "--work-dir":
        options.workDir = next();
        break;
      case "--background":
        options.background = true;
        index += 1;
        break;
      case "--foreground":
        options.background = false;
        index += 1;
        break;
      case "--background-worker":
        options.backgroundWorker = true;
        options.background = false;
        index += 1;
        break;
      case "--worker-index":
        options.workerIndex = Number(next());
        break;
      case "--source-file":
        options.workerSourceFile = next();
        break;
      case "--plan-file":
        options.workerPlanFile = next();
        break;
      case "--status-file":
        options.workerStatusFile = next();
        break;
      case "--worker-log-file":
        options.workerLogFile = next();
        break;
      case "--asset-id":
      case "--resume-asset-id":
        options.resumeAssetId = next();
        break;
      case "--transcription-only":
        options.transcriptionOnly = true;
        options.background = false;
        index += 1;
        break;
      case "--ffmpeg":
        options.ffmpeg = next();
        break;
      case "--ffprobe":
        options.ffprobe = next();
        break;
      case "--no-transcribe":
        options.transcribe = false;
        index += 1;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) fail(`Unknown argument: ${arg}`);
        options.inputs.push(arg);
        index += 1;
    }
  }

  return options;
}

function assertTool(bin, label) {
  const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    fail(
      `${label} is required for ChatCut media import. Install/fix ffmpeg first, e.g. macOS: brew install ffmpeg.`,
    );
  }
}

function bundledPlatform() {
  return `${process.platform}-${process.arch}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function materializeBundledTool(label) {
  const platform = bundledPlatform();
  const tool = BUNDLED_MEDIA_TOOLS[platform]?.[label];
  if (!tool) return undefined;

  const archive = join(
    dirname(scriptPath),
    "ffmpeg",
    platform,
    `${tool.filename}.gz`,
  );
  if (!existsSync(archive)) return undefined;

  const cacheRoot =
    process.env.CHATCUT_MEDIA_IMPORT_CACHE_DIR ||
    join(homedir(), ".chatcut", "cache", "ffmpeg");
  const cacheDir = join(cacheRoot, BUNDLED_FFMPEG_VERSION, platform);
  const destination = join(cacheDir, tool.filename);
  await mkdir(cacheDir, { recursive: true });

  if (
    existsSync(destination) &&
    (await sha256File(destination)) === tool.sha256
  ) {
    return destination;
  }
  await rm(destination, { force: true });

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      createWriteStream(temporary, { mode: 0o755 }),
    );
    const actualSha256 = await sha256File(temporary);
    if (actualSha256 !== tool.sha256) {
      fail(
        `Bundled ${label} checksum mismatch: expected ${tool.sha256}, got ${actualSha256}.`,
      );
    }
    await chmod(temporary, 0o755);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (
        !existsSync(destination) ||
        (await sha256File(destination)) !== tool.sha256
      ) {
        throw error;
      }
    }
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function resolveMediaTool(configured, label) {
  if (configured) {
    assertTool(configured, label);
    return configured;
  }

  try {
    const bundled = await materializeBundledTool(label);
    if (bundled) {
      const result = spawnSync(bundled, ["-version"], { stdio: "ignore" });
      if (!result.error && result.status === 0) {
        logProgress(`using bundled ${label} ${BUNDLED_FFMPEG_VERSION}`);
        return bundled;
      }
      logProgress(`bundled ${label} could not run; trying PATH`);
    }
  } catch (error) {
    logProgress(`bundled ${label} unavailable: ${error.message}; trying PATH`);
  }

  assertTool(label, label);
  return label;
}

async function resolveMediaTools(options) {
  [options.ffmpeg, options.ffprobe] = await Promise.all([
    resolveMediaTool(options.ffmpeg, "ffmpeg"),
    resolveMediaTool(options.ffprobe, "ffprobe"),
  ]);
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function nonNegativeNumberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function parseRate(rate) {
  if (!rate || rate === "0/0" || rate === "N/A") return undefined;
  const [numRaw, denRaw] = String(rate).split("/");
  if (denRaw !== undefined) {
    const num = Number(numRaw);
    const den = Number(denRaw);
    return den > 0 ? Number((num / den).toFixed(3)) : undefined;
  }
  return numberOrUndefined(rate);
}

function normalizeRotation(rotation) {
  const value = Number(rotation);
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value) % 360) + 360) % 360;
}

function contentTypeFor(extension) {
  switch (extension.toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".avi":
      return "video/x-msvideo";
    case ".bmp":
      return "image/bmp";
    case ".flac":
      return "audio/flac";
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".m4a":
      return "audio/mp4";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "video/webm";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function replaceExtension(filename, extension) {
  const parsed = parse(filename);
  return `${parsed.name}${extension}`;
}

function compatibleVideoCodec(codec) {
  return ["h264", "avc", "avc1", "vp8", "vp9", "av1"].includes(
    String(codec || "").toLowerCase(),
  );
}

function compatibleAudioCodec(codec) {
  return ["aac", "flac", "mp3", "mp4a", "opus", "vorbis"].includes(
    String(codec || "").toLowerCase(),
  );
}

async function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: [
        "ignore",
        options.captureStdout ? "pipe" : "ignore",
        options.captureStderr ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout)
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    if (child.stderr)
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || options.allowFailure)
        resolve({ code, stdout, stderr, timedOut });
      else {
        const reason = timedOut
          ? ` timed out after ${options.timeoutMs / 1000}s`
          : ` failed with exit code ${code}`;
        reject(
          new Error(
            `${bin}${reason}${stderr ? `: ${stderr.slice(0, 2000)}` : ""}`,
          ),
        );
      }
    });
  });
}

async function probeAudioStreamInfo(path, options) {
  const result = await run(
    options.ffprobe,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "a:0",
      path,
    ],
    {
      allowFailure: true,
      captureStdout: true,
      captureStderr: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  );
  if (result.code !== 0 || result.timedOut) return undefined;
  try {
    const data = JSON.parse(result.stdout || "{}");
    const stream = Array.isArray(data.streams) ? data.streams[0] : undefined;
    const sampleRate = Number.parseInt(stream?.sample_rate ?? "", 10);
    const channelCount = Number(stream?.channels);
    return Number.isFinite(sampleRate) &&
      sampleRate > 0 &&
      Number.isFinite(channelCount) &&
      channelCount > 0
      ? { channelCount, sampleRate }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseEbur128IntegratedLufs(output) {
  const summaryStart = output.lastIndexOf("Integrated loudness:");
  const summary = summaryStart >= 0 ? output.slice(summaryStart) : output;
  const match = summary.match(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS\b/i);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

async function probeIntegratedLufs(path, options) {
  const result = await run(
    options.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-filter_complex",
      "ebur128=peak=none",
      "-f",
      "null",
      "-",
    ],
    {
      allowFailure: true,
      captureStderr: true,
      timeoutMs: LOUDNESS_PROBE_TIMEOUT_MS,
    },
  );
  if (result.code !== 0 || result.timedOut) return undefined;
  return parseEbur128IntegratedLufs(result.stderr);
}

async function probeAudioLoudness(path, assetType, upload, options) {
  if (assetType === "video" && !upload.hasAudio) return undefined;
  if (!["audio", "video"].includes(assetType)) return undefined;
  try {
    const [streamInfo, integratedLufs] = await Promise.all([
      probeAudioStreamInfo(path, options),
      probeIntegratedLufs(path, options),
    ]);
    if (!streamInfo || integratedLufs === undefined) {
      logProgress(`loudness probe skipped for ${basename(path)}`);
      return undefined;
    }
    return { ...streamInfo, integratedLufs };
  } catch (error) {
    logProgress(
      `loudness probe skipped for ${basename(path)}: ${error.message}`,
    );
    return undefined;
  }
}

async function probeMedia(path, options) {
  const { stdout } = await run(
    options.ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,start_time,duration,channels,sample_rate:stream_tags=rotate:stream_side_data=rotation",
      "-of",
      "json",
      path,
    ],
    { captureStdout: true, captureStderr: true },
  );
  const data = JSON.parse(stdout || "{}");
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const rotation = normalizeRotation(
    video?.tags?.rotate ??
      video?.side_data_list?.find((entry) => entry.rotation != null)?.rotation,
  );
  let width = numberOrUndefined(video?.width);
  let height = numberOrUndefined(video?.height);
  if ((rotation === 90 || rotation === 270) && width && height)
    [width, height] = [height, width];
  const fps =
    parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate);
  const size = await fileSize(path);
  let sourceBitrate =
    numberOrUndefined(video?.bit_rate) ??
    numberOrUndefined(data.format?.bit_rate);
  const duration = numberOrUndefined(data.format?.duration);
  if (!sourceBitrate && duration)
    sourceBitrate = Math.floor((size * 8) / duration);

  return {
    audioCodec: audio?.codec_name || "",
    audioChannels: numberOrUndefined(audio?.channels),
    audioDuration: numberOrUndefined(audio?.duration),
    audioSampleRate: numberOrUndefined(audio?.sample_rate),
    audioStart: nonNegativeNumberOrUndefined(audio?.start_time),
    duration,
    fps,
    hasAudio: Boolean(audio?.codec_name),
    height,
    size,
    sourceBitrate,
    videoDuration: numberOrUndefined(video?.duration),
    videoCodec: video?.codec_name || "",
    width,
  };
}

async function probeSvgDimensions(path) {
  const text = await readFile(path, "utf8");
  const svgTag = text.match(/<svg\b[^>]*>/i)?.[0] || "";
  const clean = (value) =>
    numberOrUndefined(
      String(value || "")
        .trim()
        .replace(/px$/i, ""),
    );
  const width = clean(svgTag.match(/\bwidth=["']([^"']+)["']/i)?.[1]);
  const height = clean(svgTag.match(/\bheight=["']([^"']+)["']/i)?.[1]);
  if (width && height) return { width, height };
  const viewBox = svgTag
    .match(/\bviewBox=["']([^"']+)["']/i)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  return {
    width: width ?? (viewBox?.length === 4 ? clean(viewBox[2]) : undefined),
    height: height ?? (viewBox?.length === 4 ? clean(viewBox[3]) : undefined),
  };
}

function assetTypeFor(path, metadata) {
  const ext = extname(path).toLowerCase();
  if (ext === ".gif") return "gif";
  if (ext === ".svg") return "svg";
  if ([".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"].includes(ext))
    return "audio";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  if (metadata.width && metadata.height && metadata.videoCodec) return "video";
  if (metadata.audioCodec) return "audio";
  fail(`Unsupported or unprobeable media type: ${path}`);
}

function targetDimension(width, height, dimension) {
  let targetWidth = width;
  let targetHeight = height;
  const longest = Math.max(width, height);
  if (longest > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longest;
    targetWidth = Math.round(width * scale);
    targetHeight = Math.round(height * scale);
  }
  if (targetWidth % 2 !== 0) targetWidth += 1;
  if (targetHeight % 2 !== 0) targetHeight += 1;
  return Math.max(2, dimension === "width" ? targetWidth : targetHeight);
}

function recommendedBitrate(width, height) {
  const scaled =
    TARGET_PEAK_BITRATE_BPS * ((width * height) / REFERENCE_PIXELS);
  const clamped = Math.min(
    TARGET_PEAK_BITRATE_BPS,
    Math.max(TARGET_FLOOR_BITRATE_BPS, scaled),
  );
  return Math.ceil(clamped / 1000) * 1000;
}

function videoTranscodeReason(metadata, targetBitrate) {
  if (!compatibleVideoCodec(metadata.videoCodec)) {
    return `video codec ${metadata.videoCodec || "unknown"} is not browser-aligned`;
  }
  if (metadata.hasAudio && !compatibleAudioCodec(metadata.audioCodec)) {
    return `audio codec ${metadata.audioCodec || "unknown"} is not browser-aligned`;
  }
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
    return `video dimensions ${metadata.width}x${metadata.height} exceed ${MAX_DIMENSION}px`;
  }
  if (metadata.sourceBitrate) {
    const efficientBitrate = Math.max(
      targetBitrate * 1.15,
      SKIP_MAX_SOURCE_BITRATE_BPS,
    );
    if (metadata.sourceBitrate > efficientBitrate) {
      return "source bitrate exceeds efficient upload threshold";
    }
  }
  return null;
}

function thumbnailSeekTime(durationSeconds) {
  const seek = Number.isFinite(durationSeconds) ? durationSeconds * 0.3 : 0.1;
  const maxSeek =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.max(0.001, durationSeconds - 0.001)
      : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(seek, 0.001), maxSeek);
}

async function prepareThumbnail(input, upload, assetType, context) {
  if (!["gif", "image", "video"].includes(assetType)) return undefined;
  const outputPath = join(
    context.workDir,
    `chatcut-${context.nameNoExt}-thumbnail-${process.pid}-${context.index}.jpg`,
  );
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  if (assetType === "video" || assetType === "gif") {
    args.push("-ss", String(thumbnailSeekTime(upload.duration)));
  }
  args.push(
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${THUMBNAIL_MAX_WIDTH}:-2`,
    "-q:v",
    String(THUMBNAIL_QUALITY),
    outputPath,
  );
  const result = await run(context.options.ffmpeg, args, {
    allowFailure: true,
    captureStderr: true,
  });
  if (result.code !== 0) return undefined;
  return {
    contentType: "image/jpeg",
    filename: replaceExtension(context.filename, "-thumbnail.jpg"),
    path: outputPath,
    size: await fileSize(outputPath),
  };
}

async function hardwareH264Encoders(options) {
  if (process.env.CHATCUT_MEDIA_IMPORT_HWACCEL === "0") return [];
  const { stdout } = await run(
    options.ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-encoders"],
    {
      allowFailure: true,
      captureStdout: true,
      captureStderr: true,
    },
  );
  const compiled = new Set(
    [
      "h264_videotoolbox",
      "h264_nvenc",
      "h264_qsv",
      "h264_vaapi",
      "h264_amf",
    ].filter((encoder) => new RegExp(`(^|\\s)${encoder}(\\s|$)`).test(stdout)),
  );
  const preferred = process.env.CHATCUT_MEDIA_IMPORT_HW_ENCODERS
    ? process.env.CHATCUT_MEDIA_IMPORT_HW_ENCODERS.split(",").map((encoder) =>
        encoder.trim(),
      )
    : runtimeHardwareEncoderOrder();
  return preferred.filter((encoder) => compiled.has(encoder));
}

function runtimeHardwareEncoderOrder() {
  if (process.platform === "darwin") return ["h264_videotoolbox"];
  if (process.platform === "win32") {
    return ["h264_nvenc", "h264_qsv", "h264_amf"];
  }
  const hasNvidia = existsSync("/dev/nvidia0") || existsSync("/dev/nvidiactl");
  const hasDri = existsSync("/dev/dri/renderD128") || existsSync("/dev/dri");
  return [
    ...(hasNvidia ? ["h264_nvenc"] : []),
    ...(hasDri ? ["h264_vaapi", "h264_qsv", "h264_amf"] : []),
  ];
}

function vaapiDevice() {
  if (process.env.CHATCUT_MEDIA_IMPORT_VAAPI_DEVICE) {
    return process.env.CHATCUT_MEDIA_IMPORT_VAAPI_DEVICE;
  }
  return existsSync("/dev/dri/renderD128")
    ? "/dev/dri/renderD128"
    : "/dev/dri/renderD129";
}

function simpleHardwareArgs(
  baseArgs,
  encoder,
  vf,
  targetBitrate,
  metadata,
  outputPath,
) {
  const args = [
    ...baseArgs,
    "-vf",
    vf,
    "-c:v",
    encoder,
    "-b:v",
    String(targetBitrate),
    "-movflags",
    "+faststart",
  ];
  if (metadata.hasAudio) args.push("-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE);
  args.push(outputPath);
  return args;
}

function vaapiArgs(
  input,
  metadata,
  targetWidth,
  targetHeight,
  targetBitrate,
  outputPath,
) {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-vaapi_device",
    vaapiDevice(),
    "-i",
    input,
    "-map",
    "0:v:0",
  ];
  if (metadata.hasAudio) args.push("-map", "0:a:0?");
  else args.push("-an");
  args.push(
    "-vf",
    `format=nv12,hwupload,scale_vaapi=w=${targetWidth}:h=${targetHeight}`,
    "-c:v",
    "h264_vaapi",
    "-b:v",
    String(targetBitrate),
    "-movflags",
    "+faststart",
  );
  if (metadata.hasAudio) args.push("-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE);
  args.push(outputPath);
  return args;
}

async function transcodeVideo(input, metadata, context) {
  if (!metadata.width || !metadata.height || !metadata.duration) {
    fail(`Video metadata is missing dimensions/duration for ${input}`);
  }

  const targetWidth = targetDimension(metadata.width, metadata.height, "width");
  const targetHeight = targetDimension(
    metadata.width,
    metadata.height,
    "height",
  );
  const targetBitrate = recommendedBitrate(targetWidth, targetHeight);
  const reason = videoTranscodeReason(metadata, targetBitrate);
  if (!reason) {
    return {
      ...metadata,
      contentType: context.contentType,
      filename: context.filename,
      path: input,
      size: metadata.size,
      transcoded: false,
      transcodeReason: "source accepted",
    };
  }

  const vf = `scale=${targetWidth}:${targetHeight}:flags=lanczos`;
  const mp4Path = join(
    context.workDir,
    `chatcut-${context.nameNoExt}-transcode-${process.pid}-${context.index}.mp4`,
  );
  const baseArgs = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
  ];
  if (metadata.hasAudio) baseArgs.push("-map", "0:a:0?");
  else baseArgs.push("-an");

  let h264Ok = false;
  for (const encoder of await hardwareH264Encoders(context.options)) {
    if (encoder === "h264_vaapi") {
      const args = vaapiArgs(
        input,
        metadata,
        targetWidth,
        targetHeight,
        targetBitrate,
        mp4Path,
      );
      logProgress(`trying hardware H.264 transcode via ${encoder}`);
      const result = await run(context.options.ffmpeg, args, {
        allowFailure: true,
        captureStderr: true,
      });
      if (result.code === 0) {
        h264Ok = true;
        break;
      }
      logProgress(
        `hardware H.264 transcode via ${encoder} failed; trying next encoder or libx264`,
      );
      continue;
    }

    const args = [...baseArgs, "-vf", vf];
    if (encoder === "h264_videotoolbox")
      args.push(
        "-c:v",
        encoder,
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        String(targetBitrate),
        "-maxrate",
        String(targetBitrate),
        "-bufsize",
        String(targetBitrate * 2),
      );
    if (encoder === "h264_nvenc")
      args.push(
        "-c:v",
        encoder,
        "-preset",
        "p4",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        String(targetBitrate),
        "-maxrate",
        String(targetBitrate),
        "-bufsize",
        String(targetBitrate * 2),
      );
    if (encoder === "h264_qsv")
      args.push(
        "-c:v",
        encoder,
        "-preset",
        "veryfast",
        "-profile:v",
        "high",
        "-pix_fmt",
        "nv12",
        "-b:v",
        String(targetBitrate),
        "-maxrate",
        String(targetBitrate),
        "-bufsize",
        String(targetBitrate * 2),
      );
    if (encoder === "h264_amf")
      args.push(
        "-c:v",
        encoder,
        "-quality",
        "speed",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        String(targetBitrate),
        "-maxrate",
        String(targetBitrate),
        "-bufsize",
        String(targetBitrate * 2),
      );
    args.push("-movflags", "+faststart");
    if (metadata.hasAudio)
      args.push("-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE);
    args.push(mp4Path);
    logProgress(`trying hardware H.264 transcode via ${encoder}`);
    const result = await run(context.options.ffmpeg, args, {
      allowFailure: true,
      captureStderr: true,
    });
    if (result.code === 0) {
      h264Ok = true;
      break;
    }
    logProgress(
      `hardware H.264 transcode via ${encoder} failed; trying next encoder or libx264`,
    );
    const simpleArgs = simpleHardwareArgs(
      baseArgs,
      encoder,
      vf,
      targetBitrate,
      metadata,
      mp4Path,
    );
    logProgress(`trying simple hardware H.264 transcode via ${encoder}`);
    const simpleResult = await run(context.options.ffmpeg, simpleArgs, {
      allowFailure: true,
      captureStderr: true,
    });
    if (simpleResult.code === 0) {
      h264Ok = true;
      break;
    }
    logProgress(
      `simple hardware H.264 transcode via ${encoder} failed; trying next encoder or libx264`,
    );
  }

  if (!h264Ok) {
    const args = [
      ...baseArgs,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      String(targetBitrate),
      "-maxrate",
      String(targetBitrate),
      "-bufsize",
      String(targetBitrate * 2),
      "-movflags",
      "+faststart",
    ];
    if (metadata.hasAudio)
      args.push("-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE);
    args.push(mp4Path);
    const result = await run(context.options.ffmpeg, args, {
      allowFailure: true,
      captureStderr: true,
    });
    h264Ok = result.code === 0;
  }

  let outputPath = mp4Path;
  let outputFilename = replaceExtension(context.filename, ".mp4");
  let outputContentType = "video/mp4";
  if (!h264Ok) {
    outputPath = join(
      context.workDir,
      `chatcut-${context.nameNoExt}-transcode-${process.pid}-${context.index}.webm`,
    );
    outputFilename = replaceExtension(context.filename, ".webm");
    outputContentType = "video/webm";
    const args = [
      ...baseArgs,
      "-vf",
      vf,
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-row-mt",
      "1",
      "-b:v",
      String(targetBitrate),
    ];
    if (metadata.hasAudio)
      args.push("-c:a", "libopus", "-b:a", VIDEO_AUDIO_BITRATE);
    args.push(outputPath);
    await run(context.options.ffmpeg, args, { captureStderr: true }).catch(() =>
      fail(
        "Video conversion failed for ChatCut import. The file may be corrupted, too large, or use unsupported tracks.",
      ),
    );
  }

  const finalMetadata = await probeMedia(outputPath, context.options);
  return {
    ...finalMetadata,
    contentType: outputContentType,
    filename: outputFilename,
    path: outputPath,
    size: await fileSize(outputPath),
    transcoded: true,
    transcodeReason: reason,
  };
}

async function transcodeAudio(input, metadata, context) {
  if (!metadata.duration)
    fail(`Audio metadata is missing duration for ${input}`);
  const outputPath = join(
    context.workDir,
    `chatcut-${context.nameNoExt}-audio-${process.pid}-${context.index}.ogg`,
  );
  await run(
    context.options.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      AUDIO_ASSET_BITRATE,
      outputPath,
    ],
    { captureStderr: true },
  ).catch(() =>
    fail(
      "Audio conversion failed for ChatCut import. The file may be corrupted or use an unsupported codec.",
    ),
  );
  return {
    ...metadata,
    contentType: "audio/ogg",
    filename: replaceExtension(context.filename, ".ogg"),
    path: outputPath,
    size: await fileSize(outputPath),
    transcoded: true,
    transcodeReason: "audio assets follow the frontend Ogg/Opus upload path",
  };
}

async function transcriptionAudioHasSignal(path, options) {
  const result = await run(
    options.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    {
      allowFailure: true,
      captureStderr: true,
    },
  );
  const raw = result.stderr.match(
    /max_volume:\s+(-?\d+(?:\.\d+)?|-inf)\s+dB/,
  )?.[1];
  if (!raw) return true;
  if (raw === "-inf") return false;
  const value = Number(raw);
  return Number.isFinite(value)
    ? value > TRANSCRIPTION_SILENCE_MAX_VOLUME_DB
    : true;
}

function transcriptionPacketCopyFormat(metadata) {
  const codec = String(metadata.audioCodec || "").toLowerCase();
  if (OGG_PACKET_COPY_CODECS.has(codec)) return "ogg";
  return undefined;
}

function transcriptionAudioPath(context, format) {
  const target = EXTRACTED_AUDIO_FORMATS[format];
  return join(
    context.workDir,
    `chatcut-${context.nameNoExt}-transcription-${process.pid}-${context.index}${target.extension}`,
  );
}

async function copyTranscriptionAudio(input, metadata, context) {
  const format = transcriptionPacketCopyFormat(metadata);
  if (!format) return undefined;
  const target = EXTRACTED_AUDIO_FORMATS[format];
  const outputPath = transcriptionAudioPath(context, format);
  const result = await run(
    context.options.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "copy",
      outputPath,
    ],
    { allowFailure: true, captureStderr: true },
  );
  if (result.code !== 0) return undefined;
  return {
    contentType: target.contentType,
    filename: target.filename,
    format,
    path: outputPath,
    size: await fileSize(outputPath),
  };
}

async function transcodeTranscriptionAudio(input, context) {
  const target = EXTRACTED_AUDIO_FORMATS.ogg;
  const outputPath = transcriptionAudioPath(context, "ogg");
  await run(
    context.options.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      TRANSCRIPTION_AUDIO_BITRATE,
      outputPath,
    ],
    { captureStderr: true },
  ).catch(() =>
    fail(
      "Audio extraction for transcription failed. The file may have an unreadable audio track.",
    ),
  );
  return {
    contentType: target.contentType,
    filename: target.filename,
    format: "ogg",
    path: outputPath,
    size: await fileSize(outputPath),
  };
}

async function prepareTranscriptionAudioFile(input, metadata, context) {
  return (
    (await copyTranscriptionAudio(input, metadata, context)) ??
    (await transcodeTranscriptionAudio(input, context))
  );
}

async function prepareTranscriptionAudio(input, metadata, assetType, context) {
  if (!context.options.transcribe || !["audio", "video"].includes(assetType))
    return { startTranscription: false };
  if (!metadata.hasAudio)
    return {
      startTranscription: false,
      transcriptionState: "no_audio",
      transcriptionSkipReason: "no_audio_track",
    };
  const transcriptionAudio = await prepareTranscriptionAudioFile(
    input,
    metadata,
    context,
  );
  if (
    !(await transcriptionAudioHasSignal(
      transcriptionAudio.path,
      context.options,
    ))
  ) {
    logProgress(
      `detected silent audio for ${basename(input)}; marking transcription as no_audio`,
    );
    return {
      startTranscription: false,
      transcriptionState: "no_audio",
      transcriptionSkipReason: "silent_audio",
    };
  }
  return {
    startTranscription: true,
    transcriptionAudio,
  };
}

function metadataFields(assetType, upload, transcription) {
  const fields = {};
  if (["video", "audio", "gif"].includes(assetType) && upload.duration)
    fields.durationInSeconds = upload.duration;
  if (assetType === "video") {
    if (upload.height) fields.height = upload.height;
    if (upload.width) fields.width = upload.width;
    fields.hasAudioTrack = Boolean(upload.hasAudio);
    if (upload.audioStart) fields.audioStartTimestampSec = upload.audioStart;
  }
  if (["gif", "image", "svg"].includes(assetType)) {
    if (upload.height) fields.height = upload.height;
    if (upload.width) fields.width = upload.width;
  }
  if (transcription?.startTranscription) fields.startTranscription = true;
  if (transcription?.transcriptionState)
    fields.transcriptionState = transcription.transcriptionState;
  if (transcription?.transcriptionSkipReason)
    fields.transcriptionSkipReason = transcription.transcriptionSkipReason;
  if (upload.loudness) fields.loudness = upload.loudness;
  return fields;
}

function sourceManifestFields(assetType, metadata, filename) {
  const withDefinedValues = (fields) =>
    Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
  if (assetType === "video") {
    return withDefinedValues({
      audioChannels: metadata.hasAudio
        ? (metadata.audioChannels ?? null)
        : null,
      audioSampleRate: metadata.hasAudio
        ? (metadata.audioSampleRate ?? null)
        : null,
      audioStartOffsetInSeconds: metadata.hasAudio
        ? (metadata.audioStart ?? null)
        : null,
      audioStreamDurationInSeconds: metadata.hasAudio
        ? (metadata.audioDuration ?? metadata.duration ?? null)
        : null,
      originalFilename: filename,
      videoStreamDurationInSeconds: metadata.videoDuration ?? metadata.duration,
    });
  }
  if (assetType === "audio") {
    return withDefinedValues({
      audioStartOffsetInSeconds: metadata.audioStart ?? 0,
      audioStreamDurationInSeconds: metadata.audioDuration ?? metadata.duration,
      channels: metadata.audioChannels,
      originalFilename: filename,
      sampleRate: metadata.audioSampleRate,
    });
  }
  if (assetType === "gif") {
    return withDefinedValues({ fps: metadata.fps });
  }
  return undefined;
}

function sourceManifestPayload(assetType, metadata, filename) {
  const sourceManifest = sourceManifestFields(assetType, metadata, filename);
  return sourceManifest && Object.keys(sourceManifest).length > 0
    ? { sourceManifest }
    : {};
}

function metadataJson(
  sourcePath,
  assetType,
  upload,
  transcription,
  sourceMetadata = upload,
) {
  return {
    assetType,
    contentType: upload.contentType,
    filename: upload.filename,
    size: upload.size,
    sourceType: assetType,
    transcodeReason: upload.transcodeReason,
    transcoded: upload.transcoded,
    uploadFilename: upload.filename,
    uploadPath: upload.path,
    ...metadataFields(assetType, upload, transcription),
    ...sourceManifestPayload(assetType, sourceMetadata, basename(sourcePath)),
  };
}

async function postJson(body, options) {
  for (let attempt = 1; attempt <= UPLOAD_RETRY_MAX_ATTEMPTS; attempt += 1) {
    logProgress(`waiting for endpoint response: ${Object.keys(body)[0]}`);
    let response;
    try {
      response = await fetchWithTimeout(options.endpoint, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${options.sessionToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    } catch (error) {
      if (attempt < UPLOAD_RETRY_MAX_ATTEMPTS) {
        const delay = retryDelayMs(attempt);
        logProgress(
          `endpoint request failed transiently (${error.message}); retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
    const text = await response.text();
    if (response.ok) {
      logProgress(`endpoint response received: ${Object.keys(body)[0]}`);
      return text ? JSON.parse(text) : {};
    }
    if (
      attempt < UPLOAD_RETRY_MAX_ATTEMPTS &&
      isRetryableStatus(response.status)
    ) {
      const delay = retryDelayMs(attempt);
      logProgress(
        `endpoint request failed transiently (HTTP ${response.status}: ${text.slice(0, 500)}); retrying in ${delay / 1000}s`,
      );
      await sleep(delay);
      continue;
    }
    fail(
      `Token endpoint returned HTTP ${response.status}. ${text.slice(0, 2000)}`,
    );
  }
}

async function uploadSinglePut(path, url, contentType) {
  for (let attempt = 1; attempt <= UPLOAD_RETRY_MAX_ATTEMPTS; attempt += 1) {
    const size = await fileSize(path);
    logProgress(`uploading ${basename(path)}`);
    let response;
    try {
      response = await fetchWithTimeout(url, {
        body: createReadStream(path),
        duplex: "half",
        headers: {
          "Content-Length": String(size),
          "Content-Type": contentType,
        },
        method: "PUT",
      });
    } catch (error) {
      if (attempt < UPLOAD_RETRY_MAX_ATTEMPTS) {
        const delay = retryDelayMs(attempt);
        logProgress(
          `upload ${basename(path)} failed transiently (${error.message}); retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
    if (response.ok) {
      logProgress(`uploaded ${basename(path)}`);
      return undefined;
    }
    const text = await response.text();
    if (
      attempt < UPLOAD_RETRY_MAX_ATTEMPTS &&
      isRetryableStatus(response.status)
    ) {
      const delay = retryDelayMs(attempt);
      logProgress(
        `upload ${basename(path)} failed transiently (HTTP ${response.status}: ${text.slice(0, 500)}); retrying in ${delay / 1000}s`,
      );
      await sleep(delay);
      continue;
    }
    fail(
      `Upload failed for ${path} (HTTP ${response.status}). ${text.slice(0, 2000)}`,
    );
  }
}

async function uploadPart(path, partNumber, partSize, url) {
  const totalSize = await fileSize(path);
  const start = (partNumber - 1) * partSize;
  const end = Math.min(totalSize - 1, start + partSize - 1);
  if (end < start)
    fail(`Computed empty multipart upload part ${partNumber} for ${path}`);
  for (let attempt = 1; attempt <= UPLOAD_RETRY_MAX_ATTEMPTS; attempt += 1) {
    logProgress(`uploading ${basename(path)} part ${partNumber}`);
    const response = await fetchWithTimeout(url, {
      body: createReadStream(path, { start, end }),
      duplex: "half",
      headers: { "Content-Length": String(end - start + 1) },
      method: "PUT",
    }).catch((error) => ({ error }));
    if (!response.error && response.ok) {
      const etag = response.headers.get("etag")?.replace(/^"|"$/g, "");
      if (!etag)
        fail(
          `Multipart upload part ${partNumber} for ${path} did not return an ETag.`,
        );
      logProgress(`uploaded ${basename(path)} part ${partNumber}`);
      return etag;
    }
    const reason = response.error
      ? response.error.message
      : `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`;
    if (
      attempt < UPLOAD_RETRY_MAX_ATTEMPTS &&
      (response.error || isRetryableStatus(response.status))
    ) {
      const delay = retryDelayMs(attempt);
      logProgress(
        `multipart upload ${basename(path)} part ${partNumber} failed transiently (${reason}); retrying in ${delay / 1000}s`,
      );
      await sleep(delay);
      continue;
    }
    fail(
      `Multipart upload failed for ${path} part ${partNumber} after ${UPLOAD_RETRY_MAX_ATTEMPTS} attempts (${reason}).`,
    );
  }
}

async function uploadPreparedFile(file, slot, options) {
  if (!slot.multipartUploadId) {
    await uploadSinglePut(file.path, slot.presignedUrl, file.contentType);
    return undefined;
  }
  const partSize = slot.multipartPartSizeBytes;
  const partCount = slot.multipartPartCount;
  if (!partSize || !partCount)
    fail(`Invalid multipart upload slot for ${file.path}`);
  if (partCount <= 1) {
    await uploadSinglePut(file.path, slot.presignedUrl, file.contentType);
    return undefined;
  }
  const parts = [];
  for (
    let firstPartNumber = 1;
    firstPartNumber <= partCount;
    firstPartNumber += MULTIPART_SIGN_BATCH_SIZE
  ) {
    const lastPartNumber = Math.min(
      partCount,
      firstPartNumber + MULTIPART_SIGN_BATCH_SIZE - 1,
    );
    const signResult = await postJson(
      {
        signPartsRequest: {
          action: "sign_parts",
          fileKey: slot.fileKey,
          firstPartNumber,
          lastPartNumber,
          uploadId: slot.multipartUploadId,
        },
      },
      options,
    );
    const batch = [];
    for (
      let partNumber = firstPartNumber;
      partNumber <= lastPartNumber;
      partNumber += 1
    ) {
      batch.push(
        uploadPart(
          file.path,
          partNumber,
          partSize,
          signResult.partUrls[String(partNumber)],
        ).then((ETag) => ({ ETag, PartNumber: partNumber })),
      );
    }
    parts.push(...(await Promise.all(batch)));
  }
  return { uploadId: slot.multipartUploadId, parts };
}

function validateUploadSize(file) {
  if (!Number.isInteger(file.size) || file.size <= 0)
    fail(`Prepared upload file has invalid size for ${file.path}`);
}

async function uploadAndFinalizeAsset(
  assetId,
  assetType,
  upload,
  sourceMetadata,
  sourceFilename,
  prepareResult,
  options,
  startTranscription,
) {
  validateUploadSize(upload);
  const actualSize = await fileSize(upload.path);
  if (actualSize !== upload.size)
    fail(
      `Prepared upload file size changed for ${upload.path}: plan size=${upload.size} but disk reports ${actualSize}. Rebuild the upload plan.`,
    );
  const multipart = await uploadPreparedFile(
    upload,
    prepareResult.assetUpload,
    options,
  );
  let thumbnail;
  if (upload.thumbnail) {
    const slot = prepareResult.thumbnailUpload;
    if (!slot) fail("Token endpoint did not return thumbnailUpload.");
    await uploadPreparedFile(upload.thumbnail, slot, options);
    thumbnail = {
      fileKey: slot.fileKey,
      readUrl: slot.readUrl,
      size: upload.thumbnail.size,
    };
  }
  logProgress(
    `finalizing ${basename(upload.path)} with uploaded size ${actualSize} bytes`,
  );
  return postJson(
    {
      finalizeAssetUploadRequest: {
        action: "finalize_asset_upload",
        assetId,
        assetType,
        contentType: upload.contentType,
        fileKey: prepareResult.assetUpload.fileKey,
        filename: upload.filename,
        readUrl: prepareResult.assetUpload.readUrl,
        size: actualSize,
        startTranscription,
        ...(thumbnail ? { thumbnail } : {}),
        ...metadataFields(assetType, upload, undefined),
        ...sourceManifestPayload(assetType, sourceMetadata, sourceFilename),
        ...(multipart ? { multipart } : {}),
      },
    },
    options,
  );
}

async function uploadAndFinalizeTranscription(
  assetId,
  assetType,
  transcriptionAudio,
  prepareResult,
  audioStartTimestampSec,
  options,
) {
  if (!transcriptionAudio) return undefined;
  const actualSize = await fileSize(transcriptionAudio.path);
  if (actualSize !== transcriptionAudio.size)
    fail(
      `Prepared transcription file size changed for ${transcriptionAudio.path}: plan size=${transcriptionAudio.size} but disk reports ${actualSize}. Rebuild the upload plan.`,
    );
  const slot = prepareResult.transcriptionAudioUpload;
  if (!slot) fail("Token endpoint did not return transcriptionAudioUpload.");
  const multipart = await uploadPreparedFile(transcriptionAudio, slot, options);
  return postJson(
    {
      finalizeTranscriptionAudioRequest: {
        action: "finalize_transcription_audio",
        assetId,
        assetType,
        ...(assetType === "video" && audioStartTimestampSec
          ? { audioStartTimestampSec }
          : {}),
        transcriptionAudio: {
          assetId: slot.assetId,
          fileKey: slot.fileKey,
          filename: transcriptionAudio.filename,
          readUrl: slot.readUrl,
          size: actualSize,
          ...(multipart ? { multipart } : {}),
        },
      },
    },
    options,
  );
}

async function probeSource(sourceFile, index, options) {
  const filename = basename(sourceFile);
  const nameNoExt = parse(filename).name;
  const metadata = await probeMedia(sourceFile, options);
  const extension = extname(sourceFile).toLowerCase();
  const assetType = assetTypeFor(sourceFile, metadata);
  if (assetType === "svg")
    Object.assign(metadata, await probeSvgDimensions(sourceFile));
  return {
    assetType,
    context: {
      contentType: contentTypeFor(extension),
      filename,
      index,
      nameNoExt,
      options,
      workDir: options.workDir,
    },
    metadata,
  };
}

async function prepareFinalAsset(
  sourceFile,
  sourceMetadata,
  assetType,
  context,
) {
  switch (assetType) {
    case "video":
      return transcodeVideo(sourceFile, sourceMetadata, context);
    case "audio":
      return transcodeAudio(sourceFile, sourceMetadata, context);
    case "image":
    case "gif":
    case "svg":
      return {
        ...sourceMetadata,
        contentType: context.contentType,
        filename: context.filename,
        path: sourceFile,
        size: sourceMetadata.size,
        transcoded: false,
        transcodeReason: "source accepted",
      };
    default:
      fail(`Unsupported media type: ${assetType}`);
  }
}

function publicAssetResultJson(assetId) {
  return { assetId };
}

function retryHint(assetId, sourceFile, options) {
  return {
    hint: "If a background step failed, call import_media action=create_session for a fresh token, then rerun this helper with the matching argument set. Upload retry only fills assets that are still uploading/error; ready assets are not replaced.",
    assetUploadArgs: [
      "--token",
      "<fresh-token>",
      "--endpoint",
      options.endpoint,
      "--asset-id",
      assetId,
      sourceFile,
    ],
    transcriptionOnlyArgs: [
      "--token",
      "<fresh-token>",
      "--endpoint",
      options.endpoint,
      "--transcription-only",
      "--asset-id",
      assetId,
      sourceFile,
    ],
  };
}

async function prepareAndUploadRegisteredAsset(
  registeredAssetId,
  sourceFile,
  metadata,
  assetType,
  context,
  options,
  index,
  total,
) {
  const transcription = await prepareTranscriptionAudio(
    sourceFile,
    metadata,
    assetType,
    context,
  );
  if (transcription.transcriptionAudio) {
    logProgress(
      `[${index}/${total}] requesting transcription upload slot for ${basename(sourceFile)}`,
    );
    const transcriptionPrepare = await postJson(
      {
        prepareTranscriptionAudioRequest: {
          action: "prepare_transcription_audio",
          assetId: registeredAssetId,
          contentType: transcription.transcriptionAudio.contentType,
          filename: transcription.transcriptionAudio.filename,
          size: transcription.transcriptionAudio.size,
        },
      },
      options,
    );
    logProgress(
      `[${index}/${total}] uploading/finalizing transcription audio for ${basename(sourceFile)} before asset upload`,
    );
    await uploadAndFinalizeTranscription(
      registeredAssetId,
      assetType,
      transcription.transcriptionAudio,
      transcriptionPrepare,
      metadata.audioStart,
      options,
    );
  }

  logProgress(`[${index}/${total}] preparing ${basename(sourceFile)}`);
  const upload = await prepareFinalAsset(
    sourceFile,
    metadata,
    assetType,
    context,
  );
  upload.loudness = await probeAudioLoudness(
    upload.path,
    assetType,
    upload,
    context.options,
  );
  upload.thumbnail = await prepareThumbnail(
    upload.path,
    upload,
    assetType,
    context,
  );
  logProgress(
    `[${index}/${total}] requesting registered upload slots for ${basename(sourceFile)}`,
  );
  const prepareResult = await postJson(
    {
      prepareRegisteredUploadRequest: {
        action: "prepare_registered_upload",
        assetId: registeredAssetId,
        assetType,
        contentType: upload.contentType,
        filename: upload.filename,
        size: upload.size,
        ...(upload.thumbnail
          ? {
              thumbnail: {
                contentType: upload.thumbnail.contentType,
                filename: upload.thumbnail.filename,
                size: upload.thumbnail.size,
              },
            }
          : {}),
      },
    },
    options,
  );
  logProgress(
    `[${index}/${total}] uploading asset bytes for ${basename(sourceFile)}`,
  );
  const result = await uploadAndFinalizeAsset(
    registeredAssetId,
    assetType,
    upload,
    metadata,
    context.filename,
    prepareResult,
    options,
    !transcription.transcriptionAudio &&
      Boolean(transcription.startTranscription),
  );
  return {
    metadata: metadataJson(
      sourceFile,
      assetType,
      upload,
      transcription,
      metadata,
    ),
    result,
    sourcePath: sourceFile,
  };
}

async function runSingleImport(index, total, sourceFile, options) {
  logProgress(`[${index}/${total}] probing ${basename(sourceFile)}`);
  const source = await probeSource(sourceFile, index, options);
  const { assetType, context, metadata } = source;

  if (options.transcriptionOnly) {
    const transcription = await prepareTranscriptionAudio(
      sourceFile,
      metadata,
      assetType,
      context,
    );
    if (!transcription.transcriptionAudio)
      fail(
        "No prepared transcription audio was produced for this input; cannot retry transcription-only.",
      );
    logProgress(
      `[${index}/${total}] requesting transcription upload slot for ${basename(sourceFile)}`,
    );
    const prepareResult = await postJson(
      {
        prepareTranscriptionAudioRequest: {
          action: "prepare_transcription_audio",
          assetId: options.resumeAssetId,
          contentType: transcription.transcriptionAudio.contentType,
          filename: transcription.transcriptionAudio.filename,
          size: transcription.transcriptionAudio.size,
        },
      },
      options,
    );
    logProgress(
      `[${index}/${total}] uploading/finalizing transcription audio for ${basename(sourceFile)}`,
    );
    const result = await uploadAndFinalizeTranscription(
      options.resumeAssetId,
      assetType,
      transcription.transcriptionAudio,
      prepareResult,
      metadata.audioStart,
      options,
    );
    return {
      metadata: metadataJson(
        sourceFile,
        assetType,
        {
          ...metadata,
          contentType: context.contentType,
          filename: context.filename,
          path: sourceFile,
          transcoded: false,
          transcodeReason: "source accepted",
        },
        transcription,
      ),
      result,
      sourcePath: sourceFile,
      agentNext: `Call track_progress with target=transcription for assetId ${options.resumeAssetId} before transcript/caption work.`,
    };
  }

  if (assetType === "svg") {
    const transcription = { startTranscription: false };
    const upload = await prepareFinalAsset(
      sourceFile,
      metadata,
      assetType,
      context,
    );
    logProgress(
      `[${index}/${total}] requesting SVG upload slot for ${basename(sourceFile)}`,
    );
    const prepareResult = await postJson(
      {
        prepareRequest: {
          action: "prepare",
          assetType,
          contentType: upload.contentType,
          filename: upload.filename,
          size: upload.size,
        },
      },
      options,
    );
    const multipart = await uploadPreparedFile(
      upload,
      prepareResult.assetUpload,
      options,
    );
    const result = await postJson(
      {
        completeRequest: {
          action: "complete",
          assetId: prepareResult.assetUpload.assetId,
          fileKey: prepareResult.assetUpload.fileKey,
          filename: upload.filename,
          readUrl: prepareResult.assetUpload.readUrl,
          size: upload.size,
          type: assetType,
          ...metadataFields(assetType, upload, transcription),
          ...(multipart ? { multipart } : {}),
        },
      },
      options,
    );
    return {
      metadata: metadataJson(sourceFile, assetType, upload, transcription),
      result,
      sourcePath: sourceFile,
    };
  }

  const placeholderUpload = {
    ...metadata,
    contentType: context.contentType,
    filename: context.filename,
    path: sourceFile,
    size: metadata.size,
    transcoded: false,
    transcodeReason: "source accepted",
  };
  const isResumeUpload = Boolean(options.resumeAssetId);
  let registeredAssetId = options.resumeAssetId || randomUUID();
  if (!isResumeUpload) {
    placeholderUpload.thumbnail = await prepareThumbnail(
      sourceFile,
      placeholderUpload,
      assetType,
      context,
    );
  }
  if (!isResumeUpload) {
    logProgress(
      `[${index}/${total}] registering asset placeholder for ${basename(sourceFile)}`,
    );
    const registerResult = await postJson(
      {
        registerAssetPlaceholderRequest: {
          action: "register_asset_placeholder",
          assetId: registeredAssetId,
          assetType,
          contentType: placeholderUpload.contentType,
          filename: placeholderUpload.filename,
          size: placeholderUpload.size,
          ...(placeholderUpload.thumbnail
            ? {
                thumbnail: {
                  contentType: placeholderUpload.thumbnail.contentType,
                  filename: placeholderUpload.thumbnail.filename,
                  size: placeholderUpload.thumbnail.size,
                },
              }
            : {}),
          ...metadataFields(assetType, placeholderUpload, undefined),
          ...sourceManifestPayload(assetType, metadata, context.filename),
        },
      },
      options,
    );
    if (
      registerResult.assetId &&
      registerResult.assetId !== registeredAssetId
    ) {
      fail(
        `Registered asset id mismatch for ${sourceFile}: requested ${registeredAssetId} but endpoint returned ${registerResult.assetId}`,
      );
    }
    registeredAssetId = registerResult.assetId || registeredAssetId;
    if (placeholderUpload.thumbnail) {
      const slot = registerResult.thumbnailUpload;
      if (!slot) fail("Token endpoint did not return thumbnailUpload.");
      await uploadPreparedFile(placeholderUpload.thumbnail, slot, options);
    }
  }
  if (!registeredAssetId)
    fail(`Could not read registered assetId for ${sourceFile}`);

  const partialItem = {
    sourcePath: sourceFile,
    result: publicAssetResultJson(registeredAssetId),
    metadata: metadataJson(sourceFile, assetType, placeholderUpload, undefined),
    agentNext:
      "Asset is registered and can be edited now; upload is still pending. For source-frame inspection, use this item's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available.",
  };

  if (options.background) {
    const statusFile = join(
      options.workDir,
      `chatcut-import-background-status-${index}-${process.pid}.json`,
    );
    const logFile = join(
      options.workDir,
      `chatcut-import-background-${index}-${process.pid}.log`,
    );
    const planFile = join(
      options.workDir,
      `chatcut-import-background-plan-${index}-${process.pid}.json`,
    );
    await writeFile(
      statusFile,
      JSON.stringify(
        { schemaVersion: 1, status: "running", sourcePath: sourceFile },
        null,
        2,
      ),
    );
    await writeFile(
      planFile,
      JSON.stringify({ assetId: registeredAssetId }, null, 2),
    );
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--background-worker",
        "--token",
        options.sessionToken,
        "--endpoint",
        options.endpoint,
        "--work-dir",
        options.workDir,
        "--worker-index",
        String(index),
        "--source-file",
        sourceFile,
        "--plan-file",
        planFile,
        "--status-file",
        statusFile,
        "--worker-log-file",
        logFile,
        "--ffmpeg",
        options.ffmpeg,
        "--ffprobe",
        options.ffprobe,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    return {
      ...partialItem,
      agentNext:
        "Asset is registered and can be edited now; do not wait for upload just to continue timeline work. For most editing tasks, wait only for target=transcription before transcript/caption/script-aware work. For source-frame inspection, use this item's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available. If background statusFile reports an error, use retry.assetUploadArgs or retry.transcriptionOnlyArgs with a fresh import token.",
      background: { pid: child.pid, statusFile, logFile },
      retry: retryHint(registeredAssetId, sourceFile, options),
    };
  }

  const deferredUpload = async () => {
    return prepareAndUploadRegisteredAsset(
      registeredAssetId,
      sourceFile,
      metadata,
      assetType,
      context,
      options,
      index,
      total,
    );
  };
  return { deferredUpload, partialItem };
}

async function runBackgroundWorker(options) {
  const plan = JSON.parse(await readFile(options.workerPlanFile, "utf8"));
  try {
    const source = await probeSource(
      options.workerSourceFile,
      options.workerIndex,
      options,
    );
    const result = await prepareAndUploadRegisteredAsset(
      plan.assetId,
      options.workerSourceFile,
      source.metadata,
      source.assetType,
      source.context,
      options,
      options.workerIndex,
      options.workerIndex,
    );
    await writeFile(
      options.workerStatusFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "success",
          sourcePath: options.workerSourceFile,
          assetResult: result,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      options.workerStatusFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "error",
          exitCode: 1,
          failedStep: "asset_upload_or_finalize",
          assetId: plan.assetId,
          sourcePath: options.workerSourceFile,
          logFile: options.workerLogFile,
          message: error.message,
          retry: retryHint(plan.assetId, options.workerSourceFile, options),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

async function runSessionImport(options) {
  if (options.inputs.length === 0) {
    usage();
    fail("At least one input file is required.");
  }
  await resolveMediaTools(options);
  if (!options.workDir)
    options.workDir = await mkdtemp(join(tmpdir(), "chatcut-media-import-"));

  logProgress(`starting import for ${options.inputs.length} file(s)`);
  const settled = await Promise.all(
    options.inputs.map((sourceFile, index) =>
      runSingleImport(index + 1, options.inputs.length, sourceFile, options),
    ),
  );

  const partialItems = settled.map((entry) => entry.partialItem ?? entry);
  const deferredUploads = settled
    .filter((entry) => entry.deferredUpload)
    .map((entry) => entry.deferredUpload);
  if (deferredUploads.length > 0) {
    const partialResult = {
      schemaVersion: 1,
      mode: "session-imported",
      agentNext:
        "All assets are registered and you can start editing now. Uploads are still underway. For source-frame inspection, use each import's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available.",
      count: options.inputs.length,
      partial: true,
      allAssetsRegistered: true,
      uploadsStillUnderway: true,
      imports: partialItems,
    };
    await emitJson(partialResult, options);
    const finalItems = await Promise.all(
      settled.map((entry) =>
        entry.deferredUpload ? entry.deferredUpload() : entry,
      ),
    );
    await emitJson(
      {
        schemaVersion: 1,
        mode: "session-imported",
        agentNext:
          "Registered assetIds can be edited immediately. For most editing tasks, wait only for target=transcription before transcript/caption/script-aware work. For source-frame inspection, use each import's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available.",
        count: options.inputs.length,
        imports: finalItems,
      },
      options,
    );
    return;
  }

  await emitJson(
    {
      schemaVersion: 1,
      mode: "session-imported",
      agentNext: options.background
        ? "All assets are registered and you can start editing now. Uploads are still underway in the background. For source-frame inspection, use each import's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available."
        : "Registered assetIds can be edited immediately. For most editing tasks, wait only for target=transcription before transcript/caption/script-aware work. For source-frame inspection, use each import's sourcePath locally when readable. Wait for target=upload only before byte-dependent work that requires ChatCut/cloud bytes, such as export/render, pull_asset, or remote view_asset_frames when no local sourcePath is available.",
      count: options.inputs.length,
      ...(options.background
        ? {
            partial: true,
            allAssetsRegistered: true,
            uploadsStillUnderway: true,
          }
        : {}),
      imports: partialItems,
    },
    options,
  );
}

async function emitJson(value, options) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (options.jsonOut) await writeFile(options.jsonOut, json);
  else process.stdout.write(json);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.sessionToken) {
    usage();
    fail("--token is required. Call import_media action=create_session first.");
  }
  if (!options.endpoint) {
    usage();
    fail(
      "--endpoint is required. Use the endpoint returned by import_media action=create_session.",
    );
  }
  if (
    options.resumeAssetId &&
    options.inputs.length !== 1 &&
    !options.backgroundWorker
  ) {
    usage();
    fail("--asset-id can only be used with exactly one input file.");
  }
  if (options.transcriptionOnly && !options.resumeAssetId) {
    usage();
    fail("--transcription-only requires --asset-id.");
  }
  if (options.workerLogFile) {
    const logDir = dirname(options.workerLogFile);
    void logDir;
  }
  if (options.backgroundWorker) {
    await resolveMediaTools(options);
    await runBackgroundWorker(options);
  } else await runSessionImport(options);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
