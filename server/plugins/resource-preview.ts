import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";

import { validatePack } from "../../src/plugins/validate.ts";
import { withExportPermit } from "./export-runtime.ts";

// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import { renderTimeline, renderTimelineStills } from "../../remotion/render.mjs";

const MAX_BODY_BYTES = 24 * 1024 * 1024;
const POSTER_PROGRESS = 0.42;
type PreviewState = {
  readonly fps: number;
  readonly items: readonly {
    readonly startFrame: number;
    readonly durationInFrames: number;
  }[];
};
type PreviewCategory = "mg" | "transition" | "fx" | "zoom" | "lut";
const CATEGORIES = new Set<PreviewCategory>([
  "mg",
  "transition",
  "fx",
  "zoom",
  "lut",
]);
const COVER_RE = /^data:image\/(?:jpeg|png|webp);base64,/;

interface ResourcePreviewOptions {
  readonly token?: string;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true;
  const actual = String(req.headers["x-openchatcut-preview-token"] || "");
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("invalid request");
  const input = value as Record<string, unknown>;
  const category = String(input.category || "") as PreviewCategory;
  const coverDataUrl = String(input.coverDataUrl || "");
  const targetDataUrl = String(input.targetDataUrl || "");
  if (!CATEGORIES.has(category)) throw new Error("invalid preview category");
  if (category !== "mg" && !COVER_RE.test(coverDataUrl)) {
    throw new Error("valid cover image is required");
  }
  if (targetDataUrl && !COVER_RE.test(targetDataUrl)) {
    throw new Error("valid transition target image is required");
  }
  const validated = validatePack(input.pack);
  if (!validated.ok) throw new Error(validated.errors.join("; "));
  return { category, coverDataUrl, targetDataUrl, pack: validated.pack };
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

async function renderPreview(
  server: ViteDevServer,
  input: ReturnType<typeof parseRequest>,
) {
  const output = join(tmpdir(), `openchatcut-preview-${randomUUID()}.webm`);
  let poster = Buffer.alloc(0);
  try {
    await withExportPermit(async () => {
      const runtime = await server.ssrLoadModule(
        "/src/plugins/resourcePreview.ts",
      ) as {
        buildResourcePreviewState: (
          pack: typeof input.pack,
          category: PreviewCategory,
          coverDataUrl: string,
          targetDataUrl?: string,
        ) => Promise<PreviewState>;
      };
      const state = await runtime.buildResourcePreviewState(
        input.pack,
        input.category,
        input.coverDataUrl,
        input.targetDataUrl || undefined,
      );
      await renderTimeline({ state, outputLocation: output, codec: "vp8" });
      const duration = state.items.reduce(
        (max, item) => Math.max(
          max,
          item.startFrame + item.durationInFrames,
        ),
        state.fps,
      );
      const frame = Math.floor(duration * POSTER_PROGRESS);
      const stills = await renderTimelineStills({ state, frames: [frame] }) as
        Array<{ base64: string }>;
      poster = Buffer.from(stills[0]?.base64 || "", "base64");
    });
    if (!poster.length) throw new Error("preview poster render failed");
    return { video: await readFile(output), poster };
  } finally {
    await unlink(output).catch(() => undefined);
  }
}

export function resourcePreviewPlugin(
  options: ResourcePreviewOptions = {},
): Plugin {
  return {
    name: "openchatcut-resource-preview",
    configureServer(server) {
      server.middlewares.use(
        "/api/resource-preview/render",
        async (req, res) => {
          if (req.method !== "POST") {
            sendError(res, 405, "method not allowed");
            return;
          }
          if (!authorized(req, options.token)) {
            sendError(res, 401, "invalid preview token");
            return;
          }
          try {
            const preview = await renderPreview(
              server,
              parseRequest(await readJsonBody(req)),
            );
            if (String(req.headers.accept || "").includes("application/json")) {
              const body = Buffer.from(JSON.stringify({
                videoBase64: preview.video.toString("base64"),
                posterBase64: preview.poster.toString("base64"),
              }));
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Content-Length", String(body.length));
              res.end(body);
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "video/webm");
            res.setHeader("Content-Length", String(preview.video.length));
            res.end(preview.video);
          } catch (error) {
            server.config.logger.error(
              `[resource-preview] ${error instanceof Error ? error.stack : String(error)}`,
            );
            sendError(
              res,
              400,
              error instanceof Error ? error.message : "preview render failed",
            );
          }
        },
      );
    },
  };
}
