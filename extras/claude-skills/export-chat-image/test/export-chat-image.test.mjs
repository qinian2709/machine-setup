import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeCwd, parseArgs, run } from "../scripts/export-chat-image.mjs";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAA==", "base64");
const WEBP = Buffer.from("UklGRgQAAABXRUJQ", "base64");

async function fixture(images = [{ mime: "image/png", bytes: PNG }]) {
  const root = await mkdtemp(join(tmpdir(), "export-chat-image-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace with spaces");
  const projectDir = join(home, ".claude", "projects", encodeCwd(cwd));
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const content = images.map(({ mime, bytes }) => ({
    type: "image",
    source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
  }));
  const record = {
    type: "user",
    sessionId: SESSION_ID,
    cwd,
    message: { role: "user", content },
  };
  await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), `${JSON.stringify(record)}\n`);
  return { root, home, cwd, env: { CLAUDE_CODE_SESSION_ID: SESSION_ID } };
}

test("encodes Claude project directory names", () => {
  assert.equal(encodeCwd("/Users/A Name/项目"), "-Users-A-Name---");
});

test("parses selectors and encoded output modes", () => {
  assert.deepEqual(parseArgs([]), { mode: "latest", output: null, encodingOutput: null, encoding: null });
  assert.equal(parseArgs(["--index", "2"]).index, 2);
  assert.equal(parseArgs(["--all"]).mode, "all");
  assert.equal(parseArgs(["--base64-file", "x.txt"]).encoding, "base64");
  assert.throws(() => parseArgs(["--all", "--data-url", "x"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--index", "0"]), /positive integer/);
});

test("exports the latest image into bugsImage with restrictive permissions", async () => {
  const runtime = await fixture([
    { mime: "image/jpeg", bytes: JPEG },
    { mime: "image/png", bytes: PNG },
  ]);
  const results = await run(parseArgs([]), runtime);
  assert.equal(results[0].index, 2);
  assert.equal(results[0].mimeType, "image/png");
  assert.equal(results[0].output.startsWith(join(runtime.cwd, "bugsImage")), true);
  assert.deepEqual(await readFile(results[0].output), PNG);
  assert.equal((await stat(join(runtime.cwd, "bugsImage"))).mode & 0o777, 0o700);
  assert.equal((await stat(results[0].output)).mode & 0o777, 0o600);
});

test("default latest exports last image of current user message", async () => {
  const runtime = await fixture([
    { mime: "image/jpeg", bytes: JPEG },
  ]);
  const results = await run(parseArgs([]), runtime);
  assert.equal(results[0].index, 1);
  assert.equal(results[0].mimeType, "image/jpeg");
});

test("preserves an explicit single-image output path", async () => {
  const runtime = await fixture();
  const results = await run(parseArgs(["--output", "latest.png"]), runtime);
  assert.equal(results[0].output, join(runtime.cwd, "latest.png"));
  assert.deepEqual(await readFile(results[0].output), PNG);
});

test("exports a selected image as raw base64 without returning payload", async () => {
  const runtime = await fixture([
    { mime: "image/jpeg", bytes: JPEG },
  ]);
  const results = await run(parseArgs(["--index", "1", "--base64-file", "image.txt"]), runtime);
  assert.equal(await readFile(results[0].output, "utf8"), JPEG.toString("base64"));
  assert.doesNotMatch(JSON.stringify(results), /\/9j\/4AAQ/);
});

test("exports all supported image formats in order with explicit output", async () => {
  const runtime = await fixture([
    { mime: "image/png", bytes: PNG },
    { mime: "image/jpeg", bytes: JPEG },
    { mime: "image/gif", bytes: GIF },
    { mime: "image/webp", bytes: WEBP },
  ]);
  const results = await run(parseArgs(["--all", "--output", "exports"]), runtime);
  assert.deepEqual(results.map((result) => result.index), [1, 2, 3, 4]);
  assert.deepEqual(results.map((result) => result.output.split(".").at(-1)), ["png", "jpg", "gif", "webp"]);
  assert.equal((await stat(join(runtime.cwd, "exports"))).mode & 0o777, 0o700);
});

test("marks duplicate images but exports every occurrence in bugsImage", async () => {
  const runtime = await fixture([
    { mime: "image/png", bytes: PNG },
    { mime: "image/png", bytes: PNG },
  ]);
  const results = await run(parseArgs(["--all"]), runtime);
  assert.equal(results[0].index, 1);
  assert.equal(results[1].index, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].output.startsWith(join(runtime.cwd, "bugsImage")), true);
  assert.equal(results[0].duplicateOf, undefined);
  assert.equal(results[1].duplicateOf, 1);
  assert.equal((await stat(join(runtime.cwd, "bugsImage"))).mode & 0o777, 0o700);
});

test("reruns are idempotent and conflicting files are not overwritten", async () => {
  const runtime = await fixture();
  const args = parseArgs(["--output", "image.png"]);
  assert.equal((await run(args, runtime))[0].status, "created");
  assert.equal((await run(args, runtime))[0].status, "unchanged");
  await writeFile(join(runtime.cwd, "conflict.png"), "different");
  await assert.rejects(() => run(parseArgs(["--output", "conflict.png"]), runtime), /different content/);
});

test("refuses a symlink destination", async () => {
  const runtime = await fixture();
  await writeFile(join(runtime.cwd, "target.png"), PNG);
  await symlink(join(runtime.cwd, "target.png"), join(runtime.cwd, "link.png"));
  await assert.rejects(() => run(parseArgs(["--output", "link.png"]), runtime), /regular file/);
});

test("rejects MIME and signature mismatches", async () => {
  const runtime = await fixture([{ mime: "image/png", bytes: JPEG }]);
  await assert.rejects(() => run(parseArgs([]), runtime), /declared MIME type/);
});

test("rejects an image index outside the conversation", async () => {
  const runtime = await fixture();
  await assert.rejects(() => run(parseArgs(["--index", "2"]), runtime), /does not exist/);
});

test("writes a complete data URL only to the requested file", async () => {
  const runtime = await fixture();
  const results = await run(parseArgs(["--data-url", "image.data-url.txt"]), runtime);
  assert.equal(await readFile(results[0].output, "utf8"), `data:image/png;base64,${PNG.toString("base64")}`);
  assert.doesNotMatch(JSON.stringify(results), /data:image/);
});
