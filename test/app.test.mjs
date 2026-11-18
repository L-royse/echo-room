import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.mjs';
import { createMedia } from '../server/media.mjs';
import { hashPassword, verifyPassword, openStore } from '../server/store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('重启后账号、消息、会话和频道删除保持不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-store-test-')); const file = join(dir, 'echo.sqlite'); let db;
  try {
    db = openStore(file); const id = db.addUser('persist', await hashPassword('persistent-password'));
    const token = db.createSession(id); db.addMessage(1, db.publicUser(id), '保留这条消息'); db.deleteChannel(3); db.close();
    db = openStore(file); assert.equal(db.messages(1)[0].body, '保留这条消息'); assert.equal(db.session(token).username, 'persist'); assert.equal(db.channel(3), undefined);
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});
test('密码使用不同盐，正确和错误密码可区分', async () => {
  const a = await hashPassword('a-test-password-123'); const b = await hashPassword('a-test-password-123');
  assert.notEqual(a, b); assert.equal(await verifyPassword('a-test-password-123', a), true); assert.equal(await verifyPassword('wrong-password', a), false);
});
test('真实 mediasoup + HTTP + WebSocket 集成', { timeout: 30000 }, async t => {
  const config = { database: ':memory:', staticDir: 'dist', adminName: 'admin', adminPassword: 'test-admin-password-123', invite: 'private-invite-test', maxVoice: 2, maxRoom: 2, maxConnections: 10, maxUsers: 20, origin: 'http://localhost', rtcListenIp: '127.0.0.1', rtcAddress: '127.0.0.1', rtcPort: 40101 };
  const media = await createMedia(config), app = await createApplication(config, media);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`; config.origin = base;
  const clients = [];
  t.after(async () => { clients.forEach(c => c.ws.terminate()); await app.close(); });
  async function request(path, method = 'GET', body, cookie, origin = base) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
  }
  async function socket(cookie) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie, Origin: base } });
    let id = 0; const pending = new Map(), events = [];
    ws.on('message', bytes => { const value = JSON.parse(bytes); events.push(value); if (value.event === 'reply') { const task = pending.get(value.data.id); if (task) { clearTimeout(task.timer); pending.delete(value.data.id); task.resolve(value.data); } } });
    await once(ws, 'open');
    const client = { ws, events, rpc(op, data = {}) { return new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => reject(Error('RPC timeout')), 3000); pending.set(n, { resolve, timer }); ws.send(JSON.stringify({ id: n, op, data })); }); } }; clients.push(client); return client;
  }
  await t.test('未登录拒绝读取，跨站请求拒绝', async () => {
    assert.equal((await request('/api/bootstrap')).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { username: 'admin', password: config.adminPassword }, null, 'https://evil.test')).status, 403);
  });
  let admin, a, b, c;
  await t.test('管理员登录及邀请注册', async () => {
    admin = await request('/api/auth/login', 'POST', { username: 'admin', password: config.adminPassword }); assert.equal(admin.status, 200);
    assert.match(admin.headers.get('set-cookie'), /HttpOnly/i); assert.match(admin.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal((await request('/api/auth/register', 'POST', { username: 'alice', password: 'member-password-123', invite: 'bad' })).status, 403);
    for (const name of ['alice','bob','carol']) { const r = await request('/api/auth/register', 'POST', { username: name, password: 'member-password-123', invite: config.invite }); assert.equal(r.status, 200); if (name === 'alice') a = r; if (name === 'bob') b = r; if (name === 'carol') c = r; }
  });
  await t.test('普通用户不能管理频道，管理员可以创建', async () => {
    assert.equal((await request('/api/channels', 'POST', { name: '非法频道', kind: 'text' }, a.cookie)).status, 403);
    assert.equal((await request('/api/channels', 'POST', { name: '测试频道', kind: 'text' }, admin.cookie)).status, 200);
    assert.equal((await request('/api/channels', 'POST', { name: '测试频道', kind: 'text' }, admin.cookie)).status, 400);
  });
  const sa = await socket(a.cookie), sb = await socket(b.cookie), sc = await socket(c.cookie);
  await t.test('聊天消息保存，HTML 按原文存储，拒绝向语音频道写文字', async () => {
    const body = '<img src=x onerror=alert(1)>你好'; const result = await sa.rpc('chat', { channelId: 1, body }); assert.equal(result.result.body, body);
    const history = await request('/api/channels/1/messages', 'GET', null, a.cookie); assert.equal(history.data.at(-1).body, body);
    assert.ok((await sa.rpc('chat', { channelId: 2, body: 'no' })).error);
    assert.ok((await sa.rpc('chat', { channelId: 1, body: 'a'.repeat(2001) })).error);
  });
  await t.test('同房人数和全站人数限制', async () => {
    assert.ok((await sa.rpc('join', { roomId: 2 })).result.rtpCapabilities);
    assert.ok((await sb.rpc('join', { roomId: 2 })).result);
    assert.match((await sc.rpc('join', { roomId: 3 })).error, /人数/);
  });
  let ta, producer;
  await t.test('真实 SFU 传输创建和音频发布，拒绝视频和重复传输', async () => {
    ta = (await sa.rpc('transport', { direction: 'send' })).result;
    assert.ok(ta.iceCandidates.some(c => c.protocol === 'udp')); assert.ok(ta.iceCandidates.some(c => c.protocol === 'tcp'));
    assert.ok((await sa.rpc('transport', { direction: 'send' })).error);
    assert.ok((await sa.rpc('produce', { transportId: ta.id, kind: 'video', rtpParameters: {} })).error);
    const rtpParameters = { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }], encodings: [{ ssrc: 1234567 }], rtcp: { cname: 'test' } };
    producer = (await sa.rpc('produce', { transportId: ta.id, kind: 'audio', rtpParameters })).result; assert.ok(producer.id);
  });
  await t.test('音频消费仅限同房，成员不能操作别人的传输', async () => {
    assert.ok((await sb.rpc('connect', { transportId: ta.id, dtlsParameters: {} })).error);
    assert.equal((await sb.rpc('producers')).result[0].producerId, producer.id);
    await sb.rpc('join', { roomId: 3 });
    assert.deepEqual((await sb.rpc('producers')).result, []);
    const tb = (await sb.rpc('transport', { direction: 'recv' })).result;
    assert.ok((await sb.rpc('consume', { transportId: tb.id, producerId: producer.id, rtpCapabilities: media.capabilities })).error);
  });
  await t.test('管理员禁言、解除、移出及冷却', async () => {
    assert.equal((await request('/api/moderate', 'POST', { userId: a.data.id, action: 'mute' }, b.cookie)).status, 403);
    assert.equal((await request('/api/moderate', 'POST', { userId: a.data.id, action: 'mute' }, admin.cookie)).status, 200);
    await sa.rpc('mute', { muted: false });
    assert.equal(sa.events.filter(e => e.event === 'presence').at(-1).data.find(p => p.id === a.data.id).serverMuted, true);
    assert.equal((await request('/api/moderate', 'POST', { userId: a.data.id, action: 'kick' }, admin.cookie)).status, 200);
    assert.ok((await sa.rpc('join', { roomId: 2 })).error);
    assert.ok((await sc.rpc('join', { roomId: 2 })).result);
  });
  await t.test('删除正在使用的频道会移出成员且释放名额', async () => {
    assert.equal((await request('/api/channels/3', 'DELETE', null, admin.cookie)).status, 200);
    assert.ok(sb.events.some(e => e.event === 'voiceEnded'));
    assert.equal((await request('/api/channels/2', 'DELETE', null, admin.cookie)).status, 400);
  });
  await t.test('刷新连接不能绕过管理员禁言和移出冷却', async () => {
    const reopened = await socket(a.cookie);
    assert.equal(reopened.events.filter(e => e.event === 'presence').at(-1).data.find(p => p.id === a.data.id).serverMuted, true);
    assert.ok((await reopened.rpc('join', { roomId: 2 })).error);
  });
  await t.test('退出登录令会话和 websocket 失效', async () => {
    assert.equal((await request('/api/logout', 'POST', {}, b.cookie)).status, 200);
    assert.equal((await request('/api/bootstrap', 'GET', null, b.cookie)).status, 401);
  });
});
