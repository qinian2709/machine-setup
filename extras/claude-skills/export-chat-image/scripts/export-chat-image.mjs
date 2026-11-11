#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { EOL, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SKILL_INJECTION_RE = /^\(Re-invocation of \/|^Base directory for this skill:/;
const IMAGE_ANNOTATION_RE = /^\[Image:/;

class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExportError(code, message);
}

function safeError(error) {
  if (error instanceof ExportError) return error;
  return new ExportError("unexpected_error", "Unable to export the chat image.");
}

function usage() {
  return [
    "Usage: export-chat-image [--index N | --all] [--output PATH]",
    "       export-chat-image [--index N] --base64-file PATH",
    "       export-chat-image [--index N] --data-url PATH",
  ].join(EOL);
}

export function parseArgs(argv) {
  const options = { mode: "latest", output: null, encodingOutput: null, encoding: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("invalid_argument", `Missing value for ${argument}.`);
      index += 1;
      return value;
    };

    if (argument === "--index") {
      if (options.mode !== "latest") fail("invalid_argument", "Use only one image selector.");
      const value = next();
      if (!/^[1-9]\d*$/.test(value)) fail("invalid_argument", "--index must be a positive integer.");
      options.mode = "index";
      options.index = Number(value);
      continue;
    }
    if (argument === "--all") {
      if (options.mode !== "latest") fail("invalid_argument", "Use only one image selector.");
      options.mode = "all";
      continue;
    }
    if (argument === "--output") {
      if (options.output) fail("invalid_argument", "--output may be provided once.");
      options.output = next();
      continue;
    }
    if (argument === "--base64-file" || argument === "--data-url") {
      if (options.encodingOutput) fail("invalid_argument", "Choose either --base64-file or --data-url.");
      options.encoding = argument === "--base64-file" ? "base64" : "data-url";
      options.encodingOutput = next();
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    fail("invalid_argument", `Unknown argument: ${argument}`);
  }

  if (options.encodingOutput && (options.mode === "all" || options.output)) {
    fail("invalid_argument", "Encoded output cannot be combined with --all or --output.");
  }
  return options;
}

export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function regularFile(path, label) {
  const metadata = await lstat(path).catch(() => fail("not_found", `${label} was not found.`));
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail("unsafe_path", `${label} must be a regular file.`);
  return metadata;
}

async function livePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findFallbackSession(claudeRoot, cwd) {
  const sessionDir = join(claudeRoot, "sessions");
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionPath = join(sessionDir, entry.name);
    try {
      const record = JSON.parse(await readFile(sessionPath, "utf8"));
      if (!UUID_RE.test(record.sessionId) || resolve(record.cwd) !== cwd || !Number.isSafeInteger(record.pid)) continue;
      if (await livePid(record.pid)) matches.push(record.sessionId);
    } catch {
      // Ignore unrelated or malformed session registrations.
    }
  }
  if (matches.length !== 1) fail("session_not_found", "Could not uniquely identify the active Claude Code session.");
  return matches[0];
}

export async function resolveTranscript({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const canonicalCwd = resolve(cwd);
  const claudeRoot = resolve(home, ".claude");
  const sessionId = env.CLAUDE_CODE_SESSION_ID && UUID_RE.test(env.CLAUDE_CODE_SESSION_ID)
    ? env.CLAUDE_CODE_SESSION_ID
    : await findFallbackSession(claudeRoot, canonicalCwd);
  const projectDir = resolve(claudeRoot, "projects", encodeCwd(canonicalCwd));
  const transcriptPath = resolve(projectDir, `${sessionId}.jsonl`);

  if (!isWithin(resolve(claudeRoot, "projects"), projectDir) || dirname(transcriptPath) !== projectDir) {
    fail("unsafe_path", "The transcript path is outside the Claude project directory.");
  }
  await regularFile(transcriptPath, "Current session transcript");
  return { cwd: canonicalCwd, sessionId, transcriptPath };
}

function base64ToBuffer(data) {
  if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    fail("invalid_image", "An image in the transcript has invalid base64 data.");
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES || buffer.toString("base64") !== data) {
    fail("invalid_image", "An image in the transcript failed validation.");
  }
  return buffer;
}

function matchesSignature(mimeType, buffer) {
  if (mimeType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/gif") return buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function validateImage(block, imageIndex) {
  const mimeType = block?.source?.media_type;
  if (block?.type !== "image" || block?.source?.type !== "base64" || !MIME_TYPES.has(mimeType)) return null;
  const buffer = base64ToBuffer(block.source.data);
  if (!matchesSignature(mimeType, buffer)) fail("invalid_image", `Image ${imageIndex} does not match its declared MIME type.`);
  return {
    index: imageIndex,
    mimeType,
    extension: MIME_TYPES.get(mimeType),
    base64: block.source.data,
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function isRealUserMessage(content) {
  // Skip skill injection messages and blank/system messages
  if (!Array.isArray(content)) return false;
  const firstText = content.find(b => b.type === "text");
  if (!firstText?.text || !firstText.text.trim()) return false;
  return !SKILL_INJECTION_RE.test(firstText.text) && !IMAGE_ANNOTATION_RE.test(firstText.text);
}

export async function loadImages({ transcriptPath, sessionId, cwd }) {
  const allMessages = [];
  let imageIndex = 0;
  let lineNumber = 0;
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of reader) {
    lineNumber += 1;
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail("transcript_too_large", `Transcript line ${lineNumber} is too large.`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail("invalid_transcript", `Transcript line ${lineNumber} is invalid JSON.`);
    }
    if (record.type !== "user" || record.sessionId !== sessionId || resolve(record.cwd || "/") !== cwd) continue;
    const content = record.message?.content;
    if (record.message?.role !== "user" || !Array.isArray(content)) continue;
    if (!isRealUserMessage(content)) continue;
    const msgImages = [];
    for (const block of content) {
      if (block?.type !== "image") continue;
      imageIndex += 1;
      const image = validateImage(block, imageIndex);
      if (image) msgImages.push(image);
    }
    allMessages.push({ images: msgImages });
  }

  const images = allMessages.flatMap((message) => message.images);
  const latestMessageImages = allMessages.length > 0 ? allMessages.at(-1).images : [];
  return { images, latestMessageImages };
}

async function destinationIsSafe(destination) {
  const info = await lstat(destination).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) fail("unsafe_path", "Output destination must be a regular file.");
  return info;
}

async function writeAtomic(destination, content) {
  const parent = dirname(destination);
  const parentInfo = await stat(parent).catch(() => fail("output_parent_missing", "Output directory does not exist."));
  if (!parentInfo.isDirectory()) fail("output_parent_invalid", "Output parent is not a directory.");
  const existing = await destinationIsSafe(destination);
  if (existing) {
    const current = await readFile(destination);
    if (Buffer.compare(current, content) === 0) return "unchanged";
    fail("output_conflict", "Output file already exists with different content.");
  }

  const temporary = join(parent, `.${basename(destination)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code === "EEXIST") {
        const current = await readFile(destination);
        if (Buffer.compare(current, content) === 0) return "unchanged";
        fail("output_conflict", "Output file already exists with different content.");
      }
      throw error;
    }
    return "created";
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function ensureOutputDirectory(directory) {
  const info = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe_path", "Batch output must be a non-symlink directory.");
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) fail("unsafe_path", "Batch output directory is invalid.");
}

function timestampForName() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function exportOne(image, destination, encoding) {
  const content = encoding === "base64"
    ? Buffer.from(image.base64, "ascii")
    : encoding === "data-url"
      ? Buffer.from(`data:${image.mimeType};base64,${image.base64}`, "ascii")
      : image.buffer;
  const status = await writeAtomic(destination, content);
  return { index: image.index, mimeType: image.mimeType, bytes: image.buffer.length, sha256: image.sha256, status, output: destination };
}

export async function run(options, runtime = {}) {
  const { cwd = process.cwd() } = runtime;
  const session = await resolveTranscript({ ...runtime, cwd });
  const { images, latestMessageImages } = await loadImages(session);
  const allImages = options.mode === "all" ? latestMessageImages : images;
  const selected = options.mode === "all"
    ? latestMessageImages
    : options.mode === "index"
      ? [latestMessageImages[options.index - 1]].filter(Boolean)
      : latestMessageImages.length > 0 ? [latestMessageImages.at(-1)] : [];
  if (selected.length === 0 && options.mode !== 'all') return [];

  const duplicates = new Map();
  for (const image of allImages) {
    if (!duplicates.has(image.sha256)) duplicates.set(image.sha256, image.index);
  }

  const results = [];
  if (options.mode === "all") {
    const outputDirectory = resolve(cwd, options.output || "bugsImage");
    await ensureOutputDirectory(outputDirectory);
    for (const image of selected) {
      const destination = join(outputDirectory, `chat-image-${String(image.index).padStart(4, "0")}.${image.extension}`);
      results.push(await exportOne(image, destination));
    }
  } else {
    const image = selected[0];
    let destination;
    if (options.encodingOutput || options.output) {
      destination = resolve(cwd, options.encodingOutput || options.output);
    } else {
      const outputDirectory = resolve(cwd, "bugsImage");
      await ensureOutputDirectory(outputDirectory);
      destination = join(outputDirectory, `chat-image-${String(image.index).padStart(4, "0")}-${timestampForName()}.${image.extension}`);
    }
    results.push(await exportOne(image, destination, options.encoding));
  }

  return results.map((result) => ({ ...result, duplicateOf: duplicates.get(result.sha256) === result.index ? undefined : duplicates.get(result.sha256) }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}${EOL}`);
    return;
  }
  const results = await run(options);
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}${EOL}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`${JSON.stringify({ error: safe.code, message: safe.message })}${EOL}`);
    process.exitCode = 1;
  });
}
