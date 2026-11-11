import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { encodeCwd } from '../../export-chat-image/scripts/export-chat-image.mjs';
import { buildDescription, execute, parseArgs, resolveConfig, resolveOwner } from '../scripts/tapd-bug.mjs';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64');
const TOKEN = 'secret-token-that-must-not-leak';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tapd-bug-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const project = join(home, '.claude', 'projects', encodeCwd(cwd));
  await mkdir(project, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const record = {
    type: 'user', sessionId: SESSION_ID, cwd,
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] },
  };
  await writeFile(join(project, `${SESSION_ID}.jsonl`), `${JSON.stringify(record)}\n`);
  await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { tapd: { env: { TAPD_ACCESS_TOKEN: TOKEN, TAPD_DEFAULT_WORKSPACE_ID: '35572188', TAPD_NICK_NAME: 'kailiang.qiu' } } } }));
  return { root, home, cwd, env: { CLAUDE_CODE_SESSION_ID: SESSION_ID } };
}

function tapdResponse(bug) {
  return new Response(JSON.stringify({ data: { Bug: bug } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('parses create and update contracts', () => {
  assert.equal(parseArgs(['create', '--title', 'Title']).operation, 'create');
  assert.equal(parseArgs(['update', '--id', '1135572188001272856']).append, true);
  assert.throws(() => parseArgs(['create']), /title is required/);
  assert.throws(() => parseArgs(['update', '--id', 'bad']), /valid --id/);
});

test('builds structured HTML with image data URI in memory', () => {
  const html = buildDescription({ env: 'IM环境 / 账号12300002501', steps: '1. 操作', actual: '<broken>', expected: '应正常通过' }, [{ mimeType: 'image/png', base64: PNG.toString('base64') }]);
  assert.match(html, /【账号环境】/);
  assert.match(html, /【测试步骤】/);
  assert.match(html, /【实际结果】/);
  assert.match(html, /【预期结果】/);
  assert.match(html, /<img\s/);
  assert.match(html, /data:image\/png;base64/);
  assert.doesNotMatch(html, /&lt;img\s/);
});

test('resolves environment before mcp config', async () => {
  const runtime = await fixture();
  const config = await resolveConfig({ owner: 'owner.override' }, { cwd: runtime.cwd, env: { TAPD_ACCESS_TOKEN: 'env-token', TAPD_DEFAULT_WORKSPACE_ID: '99' } });
  assert.equal(config.token, 'env-token');
  assert.equal(config.workspaceId, '99');
  assert.equal(config.owner, 'owner.override');
});

test('resolves configured Chinese owner aliases and passes nicknames through', async () => {
  const runtime = await fixture();
  const aliasesPath = join(runtime.root, 'owner-aliases.json');
  await writeFile(aliasesPath, JSON.stringify({ '邱开亮': 'kailiang.qiu' }));
  assert.deepEqual(await resolveOwner('邱开亮', { aliasesPath }), { ownerInput: '邱开亮', owner: 'kailiang.qiu' });
  assert.deepEqual(await resolveOwner('kailiang.qiu', { aliasesPath }), { ownerInput: 'kailiang.qiu', owner: 'kailiang.qiu' });
  await assert.rejects(() => resolveOwner('未知人员', { aliasesPath }), (error) => error.code === 'owner_not_mapped');
});

test('creates a Bug and validates TAPD image conversion', async () => {
  const runtime = await fixture();
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    const body = options.body;
    assert.match(body.get('description'), /data:image\/png;base64/);
    return tapdResponse({ id: '1135572188001279999', title: 'Title', current_owner: 'kailiang.qiu', description: '<p><img src="/tfl/captures/image.png"/></p>' });
  };
  const result = await execute(parseArgs(['create', '--title', 'Title', '--problem', 'Problem']), { ...runtime, fetchImpl });
  assert.equal(result.status, 'created');
  assert.equal(result.ownerInput, 'kailiang.qiu');
  assert.equal(result.imagesConverted, 1);
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.body.get('current_owner'), 'kailiang.qiu');
  assert.doesNotMatch(JSON.stringify(result), /secret-token|base64|data:image/);
});

test('updates by fetching and preserving the existing description', async () => {
  const runtime = await fixture();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [{ Bug: { id: '1135572188001272856', description: '<p>existing</p>' } }] }), { status: 200 });
    assert.match(options.body.get('description'), /^<p>existing<\/p>/);
    return tapdResponse({ id: '1135572188001272856', description: '<p>existing</p><p><img src="/tfl/captures/image.png"/></p>' });
  };
  const result = await execute(parseArgs(['update', '--id', '1135572188001272856', '--problem', 'more']), { ...runtime, fetchImpl });
  assert.equal(calls, 2);  // 1 GET description + 1 POST (update mode skips dedup)
  assert.equal(result.status, 'updated');
});

test('replace mode skips the current-description fetch', async () => {
  const runtime = await fixture();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    return tapdResponse({ id: '1135572188001272856', description: '<p><img src="/tfl/captures/image.png"/></p>' });
  };
  await execute(parseArgs(['update', '--id', '1135572188001272856', '--replace-description', '--problem', 'new']), { ...runtime, fetchImpl });
  assert.equal(calls, 1);
});

test('rejects a response that leaves the data URI unconverted', async () => {
  const runtime = await fixture();
  const fetchImpl = async () => tapdResponse({ id: '1135572188001279999', description: `<img src="data:image/png;base64,${PNG.toString('base64')}"/>` });
  await assert.rejects(() => execute(parseArgs(['create', '--title', 'Title']), { ...runtime, fetchImpl }), (error) => {
    assert.equal(error.code, 'tapd_image_conversion_failed');
    assert.doesNotMatch(error.message, /iVBOR|secret-token/);
    return true;
  });
});

test('does not retry an ambiguous network failure', async () => {
  const runtime = await fixture();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; if (calls === 1) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); throw new Error('network'); };
  await assert.rejects(() => execute(parseArgs(['create', '--title', 'Title']), { ...runtime, fetchImpl }), /not retried/);
  assert.equal(calls, 2);
});

test('supports text-only dry runs without network mutation', async () => {
  const runtime = await fixture();
  const result = await execute(parseArgs(['create', '--title', 'Title', '--no-image', '--dry-run']), { ...runtime, fetchImpl: async () => assert.fail('must not fetch') });
  assert.equal(result.status, 'validated');
  assert.equal(result.imagesSubmitted, 0);
});
