#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadImages, resolveTranscript } from "../../export-chat-image/scripts/export-chat-image.mjs";

const SKILL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OWNER_ALIASES_PATH = join(SKILL_DIRECTORY, "..", "config", "owner-aliases.json");

const DEFAULTS = {
  apiBaseUrl: "https://api.tapd.cn",
  workspaceId: "35572188",
  owner: "kailiang.qiu",
  reporter: "kailiang.qiu",
};
const BUG_ID_RE = /^\d{10,24}$/;
const VALUE_FLAGS = new Map([
  ["--id", "id"],
  ["--title", "title"],
  ["--module", "module"],
  ["--problem", "problem"],
  ["--steps", "steps"],
  ["--env", "env"],
  ["--actual", "actual"],
  ["--expected", "expected"],
  ["--impact", "impact"],
  ["--description-html", "descriptionHtml"],
  ["--description-file", "descriptionFile"],
  ["--image-index", "imageIndex"],
  ["--workspace-id", "workspaceId"],
  ["--owner", "owner"],
  ["--reporter", "reporter"],
  ["--priority", "priority"],
  ["--priority-label", "priorityLabel"],
  ["--severity", "severity"],
  ["--iteration-id", "iterationId"],
  ["--bugtype", "bugtype"],
  ["--source", "source"],
  ["--testphase", "testphase"],
  ["--version-report", "versionReport"],
  ["--custom-field-one", "customFieldOne"],
  ["--custom-field-two", "customFieldTwo"],
  ["--custom-field-five", "customFieldFive"],
  ["--config", "configPath"],
  ["--owner-aliases", "ownerAliasesPath"],
]);

class TapdBugError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.code = code;
    this.metadata = metadata;
  }
}

function fail(code, message, metadata) {
  throw new TapdBugError(code, message, metadata);
}

export function parseArgs(argv) {
  const operation = argv[0];
  if (!['create', 'update'].includes(operation)) fail('invalid_argument', 'First argument must be create or update.');
  const options = { operation, imageMode: 'latest', append: operation === 'update', dryRun: false };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('invalid_argument', `Missing value for ${argument}.`);
      options[VALUE_FLAGS.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === '--all-images') options.imageMode = 'all';
    else if (argument === '--no-image') options.imageMode = 'none';
    else if (argument === '--append-description') options.append = true;
    else if (argument === '--replace-description') options.append = false;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force-create') options.forceCreate = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('invalid_argument', `Unknown argument: ${argument}`);
  }

  if (options.imageIndex) {
    if (options.imageMode !== 'latest' || !/^[1-9]\d*$/.test(options.imageIndex)) fail('invalid_argument', '--image-index must be a positive integer and cannot be combined with another image selector.');
    options.imageMode = 'index';
    options.imageIndex = Number(options.imageIndex);
  }
  if (operation === 'create' && !options.title) fail('invalid_argument', '--title is required for create.');
  if (operation === 'update' && (!options.id || !BUG_ID_RE.test(options.id))) fail('invalid_argument', 'A valid --id is required for update.');
  if (options.descriptionHtml && options.descriptionFile) fail('invalid_argument', 'Choose --description-html or --description-file.');
  return options;
}

function escapeHtml(value = '') {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function paragraphs(value) {
  // 先把用户传入的 <br /> 转成换行符，避免被 escapeHtml 转义
  const normalized = value.replaceAll(/<br\s*\/?>/gi, '\n');
  return escapeHtml(normalized).replaceAll(/\r?\n/g, '<br />');
}

export function buildDescription(options, images) {
  if (options.descriptionHtml) return `${options.descriptionHtml}${imageHtml(images)}`;
  const imageSection = images.length
    ? images.map((image) => `<p><img src="data:${image.mimeType};base64,${image.base64}" width="80%"/></p>`).join('\n')
    : '';
  const sections = [
    ['账号环境', options.env],
    ['测试步骤', options.steps],
    ['实际结果', options.actual],
    ['预期结果', options.expected],
  ].filter(([, value]) => value);
  const html = sections.map(([label, value]) => {
    const body = label === '实际结果' && imageSection
      ? `<p>${paragraphs(value)}</p>\n${imageSection}`
      : `<p>${paragraphs(value)}</p>`;
    return `<p><strong>【${label}】</strong></p>\n${body}`;
  }).join('\n');
  const tail = imageSection && !sections.some(([label]) => label === '实际结果')
    ? `${html ? '\n' : ''}${imageHtml(images)}`
    : '';
  return `${html}${tail}`;
}

function imageHtml(images) {
  if (images.length === 0) return '';
  return `\n<p><strong>【截图】</strong></p>\n${images.map((image) => `<p><img src="data:${image.mimeType};base64,${image.base64}" width="80%"/></p>`).join('\n')}`;
}

async function findConfig(start) {
  let directory = resolve(start);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, '.mcp.json');
    try {
      await access(candidate);
      return candidate;
    } catch {}
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

async function readConfig(path) {
  if (!path) return {};
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value?.mcpServers?.tapd?.env || {};
  } catch {
    fail('tapd_config_invalid', 'Unable to read TAPD configuration.');
  }
}

async function readOwnerAliases(path) {
  try {
    const aliases = JSON.parse(await readFile(path, 'utf8'));
    if (!aliases || Array.isArray(aliases) || typeof aliases !== 'object') fail('owner_aliases_invalid', 'Owner aliases must be a JSON object.');
    for (const [name, nickname] of Object.entries(aliases)) {
      if (typeof name !== 'string' || !name.trim() || typeof nickname !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(nickname)) {
        fail('owner_aliases_invalid', 'Owner aliases contain an invalid TAPD nickname.');
      }
    }
    return aliases;
  } catch (error) {
    if (error instanceof TapdBugError) throw error;
    fail('owner_aliases_unavailable', 'Owner aliases file is unavailable; refusing to create a Bug without a verified owner.');
  }
}

export async function resolveOwner(ownerInput, { aliasesPath = DEFAULT_OWNER_ALIASES_PATH } = {}) {
  const requestedOwner = ownerInput || DEFAULTS.owner;
  const aliases = await readOwnerAliases(aliasesPath);
  if (Object.hasOwn(aliases, requestedOwner)) {
    return { ownerInput: requestedOwner, owner: aliases[requestedOwner] };
  }
  if (/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(requestedOwner)) {
    return { ownerInput: requestedOwner, owner: requestedOwner };
  }
  fail('owner_not_mapped', `No verified TAPD nickname is configured for “${requestedOwner}”. Add the mapping before creating a Bug.`);
}

export async function resolveConfig(options, { cwd = process.cwd(), env = process.env } = {}) {
  const configPath = options.configPath ? resolve(cwd, options.configPath) : await findConfig(cwd);
  const stored = await readConfig(configPath);
  const token = env.TAPD_ACCESS_TOKEN || stored.TAPD_ACCESS_TOKEN;
  if (!token) fail('tapd_auth_missing', 'TAPD_ACCESS_TOKEN is required.');
  return {
    token,
    apiBaseUrl: env.TAPD_API_BASE_URL || stored.TAPD_API_BASE_URL || DEFAULTS.apiBaseUrl,
    workspaceId: String(options.workspaceId || env.TAPD_DEFAULT_WORKSPACE_ID || stored.TAPD_DEFAULT_WORKSPACE_ID || DEFAULTS.workspaceId),
    owner: options.owner || env.TAPD_NICK_NAME || stored.TAPD_NICK_NAME || DEFAULTS.owner,
    reporter: options.reporter || env.TAPD_NICK_NAME || stored.TAPD_NICK_NAME || DEFAULTS.reporter,
    configPath,
  };
}

async function selectImages(options, runtime) {
  if (options.imageMode === 'none') return [];
  const session = await resolveTranscript(runtime);
  const { latestMessageImages } = await loadImages(session);
  // Never fall back to older messages — only the latest user message matters.
  // If the latest message has no images, the user doesn't want to attach any.
  if (options.imageMode === 'all') return latestMessageImages;
  if (options.imageMode === 'index') {
    const image = latestMessageImages[options.imageIndex - 1];
    if (!image) fail('image_not_found', 'The requested image index does not exist in the latest message.');
    return [image];
  }
  return latestMessageImages;
}

// 判断当前用户消息是否包含图片
function hasImageInCurrentMessage(options, runtime) {
  return selectImages(options, runtime).then((imgs) => imgs.length > 0, () => false);
}

async function requestTapd(url, params, token, fetchImpl, method = 'POST') {
  let response;
  try {
    const requestUrl = method === 'GET' ? `${url}?${params.toString()}` : url;
    response = await fetchImpl(requestUrl, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
      },
      ...(method === 'POST' ? { body: params } : {}),
    });
  } catch {
    fail('tapd_network_error', 'TAPD request failed; the operation was not retried because its outcome may be ambiguous.');
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail('tapd_invalid_response', 'TAPD returned an invalid response.');
  }
  if (!response.ok || payload.status >= 400) fail('tapd_api_error', payload.info || `TAPD returned HTTP ${response.status}.`);
  const result = payload.data?.Bug || payload.Bug || payload.data || payload;
  return Array.isArray(result) ? (result[0]?.Bug || result[0]) : result;
}

function descriptionFromBug(bug) {
  return typeof bug?.description === 'string' ? bug.description : '';
}

function validateResult(bug, { operation, id, imageCount }) {
  if (!bug?.id) fail('tapd_invalid_response', 'TAPD did not return a Bug ID.');
  if (operation === 'update' && String(bug.id) !== String(id)) fail('tapd_invalid_response', 'TAPD returned a different Bug ID.');
  const description = descriptionFromBug(bug);
  const imgCount = (description.match(/<img\b/gi) || []).length;
  const tflCount = (description.match(/\/tfl\//g) || []).length;
  const hasDataUri = /data:image\/|;base64,/i.test(description);
  if (imageCount > 0 && (imgCount < imageCount || tflCount < imageCount || hasDataUri)) {
    fail('tapd_image_conversion_failed', 'TAPD created or updated the Bug but did not fully convert the embedded image.', { bugId: String(bug.id), imgCount, tflCount, hasDataUri });
  }
  return { imgCount, tflCount, hasDataUri };
}

function setOptional(params, key, value) {
  if (value !== undefined && value !== '') params.set(key, String(value));
}

function extractKeywords(title) {
  return (title || '').replace(/【[^】]+】/g, '').replace(/[^一-鿿\w\s.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleSimilar(a, b) {
  const ka = extractKeywords(a);
  const kb = extractKeywords(b);
  if (!ka || !kb) return 0;
  return Math.max(
    ka === kb ? 1 : 0,
    ka.includes(kb) || kb.includes(ka) ? 0.85 : 0,
  );
}

async function checkDuplicate(options, { config, fetchImpl }) {
  const title = options.title;
  const owner = options.owner || config.owner;
  if (!title || !owner) return null;

  const searchParams = new URLSearchParams({ workspace_id: config.workspaceId, current_owner: owner });
  if (options.iterationId) searchParams.set('iteration_id', options.iterationId);
  searchParams.set('limit', '30');
  searchParams.set('order', 'created desc');

  let bugs;
  try {
    const result = await requestTapd(`${config.apiBaseUrl.replace(/\/$/, '')}/bugs`, searchParams, config.token, fetchImpl, 'GET');
    bugs = Array.isArray(result) ? result.map((r) => r.Bug || r).filter((b) => b && b.title && b.id) : [];
  } catch {
    bugs = []; // 查重失败不妨碍提单
  }

  const candidates = bugs
    .filter((b) => !['resolved', 'closed', 'rejected', '已验证', '已关闭'].includes(b.status) && titleSimilar(title, b.title) >= 0.7)
    .sort((a, b) => new Date(b.modified || b.created || 0).getTime() - new Date(a.modified || a.created || 0).getTime());

  if (candidates.length === 0) return null;
  if (candidates.length === 1 && titleSimilar(title, candidates[0].title) >= 0.8) {
    // 高相似度唯一匹配：自动追加
    return {
      operation: 'update (auto-dedup)',
      dedupMatched: candidates[0].id,
      dedupTitle: candidates[0].title,
      workspaceId: config.workspaceId,
      ownerInput: options.owner || 'kailiang.qiu',
      owner: owner,
      imagesSubmitted: 0,
      imagesConverted: 0,
      tflImagesInDescription: 0,
      status: 'deduped',
      hint: `A similar Bug was found and needs manual attachment. Use update --id ${candidates[0].id} to append.`,
    };
  }

  // 多个或中等相似度：列出候选让 Agent 选择，脚本层面不直接更新（防止误判）
  return {
    operation: 'create (blocked)',
    dedupCandidates: candidates.slice(0, 5).map((c) => ({ id: c.id, title: c.title, status: c.status })),
    workspaceId: config.workspaceId,
    ownerInput: options.owner || 'kailiang.qiu',
    owner: owner,
    imagesSubmitted: 0,
    status: 'dedup_blocked',
    hint: `Possible duplicate Bugs were found. Review and either approve the automatic match or use --force-create to skip dedup.`,
  };
}

export async function execute(options, runtime = {}) {
  const cwd = runtime.cwd || process.cwd();
  if (options.descriptionFile) options = { ...options, descriptionHtml: await readFile(resolve(cwd, options.descriptionFile), 'utf8') };
  const config = await resolveConfig(options, { cwd, env: runtime.env || process.env });
  const ownerAliasesPath = options.ownerAliasesPath
    ? resolve(cwd, options.ownerAliasesPath)
    : runtime.ownerAliasesPath || DEFAULT_OWNER_ALIASES_PATH;
  const ownerResolution = await resolveOwner(options.owner || config.owner, { aliasesPath: ownerAliasesPath });
  const images = await selectImages(options, { cwd, env: runtime.env || process.env, home: runtime.home || homedir() });
  // 如果最新一条消息没有图片，当前 Bug 按无图处理
  const effectiveImageMode = images.length === 0 ? 'none' : options.imageMode;
  // 如果是无图模式，清空图片列表
  const effectiveImages = effectiveImageMode === 'none' ? [] : images;
  let description = buildDescription(options, images);
  const fetchImpl = runtime.fetchImpl || globalThis.fetch;

  if (options.dryRun) {
    return { operation: options.operation, workspaceId: config.workspaceId, ownerInput: ownerResolution.ownerInput, owner: ownerResolution.owner, imagesSubmitted: images.length, status: 'validated' };
  }

  // 查重：只在 create 模式下检查，update 和 force-create 跳过
  let operation = options.operation;
  let bugId = options.id;
  if (operation === 'create' && !options.forceCreate) {
    const dupe = await checkDuplicate(options, { config, fetchImpl });
    if (dupe) return dupe;
  }
  // update 模式下获取当前 bug 描述用于追加
  if (operation === 'update' && options.append) {
    const currentParams = new URLSearchParams({ workspace_id: config.workspaceId, id: bugId });
    const current = await requestTapd(`${config.apiBaseUrl.replace(/\/$/, '')}/bugs`, currentParams, config.token, fetchImpl, 'GET');
    description = `${descriptionFromBug(current)}${description}`;
  }

  const params = new URLSearchParams();
  params.set('workspace_id', config.workspaceId);
  if (operation === 'update') params.set('id', bugId);
  if (options.title) params.set('title', options.title);
  params.set('description', description);
  params.set('current_owner', ownerResolution.owner);
  params.set('reporter', config.reporter);
  setOptional(params, 'priority', options.priority);
  setOptional(params, 'priority_label', options.priorityLabel);
  setOptional(params, 'severity', options.severity);
  setOptional(params, 'bugtype', options.bugtype);
  setOptional(params, 'source', options.source);
  setOptional(params, 'iteration_id', options.iterationId);
  setOptional(params, 'testphase', options.testphase);
  setOptional(params, 'version_report', options.versionReport);
  setOptional(params, 'custom_field_one', options.customFieldOne);
  setOptional(params, 'custom_field_two', options.customFieldTwo);
  setOptional(params, 'custom_field_five', options.customFieldFive);

  const bug = await requestTapd(`${config.apiBaseUrl.replace(/\/$/, '')}/bugs`, params, config.token, fetchImpl);
  const conversion = validateResult(bug, { operation, id: bugId, imageCount: images.length });
  return {
    operation,
    bugId: String(bug.id),
    title: bug.title || options.title,
    ownerInput: ownerResolution.ownerInput,
    owner: bug.current_owner || ownerResolution.owner,
    workspaceId: config.workspaceId,
    imagesSubmitted: images.length,
    imagesConverted: images.length,
    tflImagesInDescription: conversion.tflCount,
    status: operation === 'create' ? 'created' : 'updated',
  };
}

function usage() {
  return 'Usage: tapd-bug create --title TITLE [fields] | tapd-bug update --id BUG_ID [fields]';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(`${usage()}\n`);
  process.stdout.write(`${JSON.stringify(await execute(options))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = error instanceof TapdBugError ? error : new TapdBugError('unexpected_error', 'Unable to complete the TAPD Bug operation.');
    process.stderr.write(`${JSON.stringify({ error: safe.code, message: safe.message, ...safe.metadata })}\n`);
    process.exitCode = 1;
  });
}
