import express from 'express';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { openStore, hashPassword, verifyPassword } from './store.mjs';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const positiveId = value => { if (!Number.isSafeInteger(value) || value < 1) throw fail('编号无效'); return value; };
function text(value, min, max) { if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw fail(`内容长度须为 ${min}–${max} 字`); return value.trim(); }
function cookie(req) { return /(?:^|;\s*)echo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
const safeEqual = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function createApplication(config, media) {
  const store = openStore(config.database);
  if (!store.userByName(config.adminName)) store.addUser(config.adminName, await hashPassword(config.adminPassword), 'admin');
  const dummyPassword = await hashPassword('dummy-password-for-equal-work');
  const app = express(), server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false });
  const peers = new Map(), limits = new Map(), moderation = new Map();
  let authBusy = 0;
  const ip = req => config.production ? (req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
  function rate(key, count, window = 60000) {
    const now = Date.now(); let item = limits.get(key);
    if (!item || item.until < now) { item = { count: 0, until: now + window }; limits.set(key, item); }
    if (++item.count > count) throw fail('操作太频繁，请稍后重试', 429);
  }
  const send = (peer, event, data) => {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > 1024 * 1024) return peer.ws.terminate();
    peer.ws.send(JSON.stringify({ event, data }));
  };
  const broadcast = (event, data) => { for (const p of peers.values()) send(p, event, data); };
  const presence = () => [...peers.values()].map(p => ({ ...p.user, room: p.room, muted: p.muted, deafened: p.deafened, serverMuted: p.serverMuted }));
  const publish = () => broadcast('presence', presence());
  function leave(p) {
    const producerId = p.producer?.id;
    p.room = null;
    for (const t of p.transports.values()) t.close();
    p.transports.clear(); p.consumers.clear(); p.producer = null; p.muted = false; p.deafened = false;
    if (producerId) broadcast('producerClosed', { producerId });
    publish();
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(self)', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.origin) return res.status(403).json({ error: '请求来源不匹配' });
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  const auth = (req, res, next) => { req.user = store.session(cookie(req)); if (!req.user) return res.status(401).json({ error: '请先登录' }); next(); };
  function session(res, id) { res.cookie('echo_session', store.createSession(id), { httpOnly: true, sameSite: 'strict', secure: config.production, maxAge: 7 * 86400000, path: '/' }); }
  app.post('/api/auth/:action', async (req, res) => {
    rate(`auth:${ip(req)}`, 15, 15 * 60000);
    if (authBusy >= 2) throw fail('登录服务繁忙，请稍后重试', 429);
    authBusy++;
    try {
      const username = text(req.body.username, 2, 24), password = text(req.body.password, 12, 128);
      if (!/^[\p{L}\p{N}_-]+$/u.test(username)) throw fail('用户名只支持文字、数字、下划线和短横线');
      if (req.params.action === 'register') {
        if (!safeEqual(String(req.body.invite || ''), config.invite)) throw fail('邀请码不正确', 403);
        if (store.userCount() >= config.maxUsers) throw fail('注册人数已达上限', 403);
        if (store.userByName(username)) throw fail('用户名已被使用', 409);
        const passwordHash = await hashPassword(password);
        if (store.userCount() >= config.maxUsers || store.userByName(username)) throw fail('人数已满或用户名已被使用', 409);
        const id = store.addUser(username, passwordHash); session(res, id); return res.json(store.publicUser(id));
      }
      if (req.params.action !== 'login') throw fail('接口不存在', 404);
      const user = store.userByName(username);
      const valid = await verifyPassword(password, user?.password || dummyPassword);
      if (!user || !valid) throw fail('用户名或密码不正确', 401);
      peers.get(user.id)?.ws.close(4001, '账号在另一处登录');
      session(res, user.id); res.json(store.publicUser(user.id));
    } finally { authBusy--; }
  });
  app.post('/api/logout', auth, (req, res) => { store.deleteSession(cookie(req)); peers.get(req.user.id)?.ws.close(4001, '已退出登录'); res.clearCookie('echo_session', { path: '/' }); res.json({ ok: true }); });
  app.get('/api/bootstrap', auth, (req, res) => res.json({ user: req.user, channels: store.channels(), maxVoice: config.maxVoice, maxRoom: config.maxRoom }));
  app.get('/api/channels/:id/messages', auth, (req, res) => {
    rate(`read:${req.user.id}`, 180);
    const id = positiveId(Number(req.params.id));
    if (store.channel(id)?.kind !== 'text') throw fail('文字频道不存在', 404);
    const before = req.query.before ? positiveId(Number(req.query.before)) : undefined;
    res.json(store.messages(id, before));
  });
  app.post('/api/channels', auth, (req, res) => {
    if (req.user.role !== 'admin') throw fail('需要管理员权限', 403);
    const name = text(req.body.name, 1, 24), kind = req.body.kind;
    if (!['text', 'voice'].includes(kind)) throw fail('频道类型无效');
    if (store.channels().length >= 12) throw fail('最多 12 个频道');
    if (store.channels().some(c => c.name === name)) throw fail('频道名称已存在');
    store.addChannel(name, kind); broadcast('channels', store.channels()); res.json({ ok: true });
  });
  app.delete('/api/channels/:id', auth, (req, res) => {
    if (req.user.role !== 'admin') throw fail('需要管理员权限', 403);
    const id = positiveId(Number(req.params.id)), channel = store.channel(id);
    if (!channel) throw fail('频道不存在', 404);
    if (store.channels().filter(c => c.kind === channel.kind).length <= 1) throw fail('每种类型至少保留一个频道');
    for (const p of peers.values()) if (p.room === id) { leave(p); send(p, 'voiceEnded', { reason: '频道已删除' }); }
    store.deleteChannel(id); broadcast('channels', store.channels()); res.json({ ok: true });
  });
  app.post('/api/moderate', auth, (req, res) => {
    if (req.user.role !== 'admin') throw fail('需要管理员权限', 403);
    const p = peers.get(positiveId(req.body.userId));
    if (!p) throw fail('用户已离线', 404);
    if (req.body.action === 'kick') { leave(p); p.moderation.kickedUntil = Date.now() + 60000; send(p, 'voiceEnded', { reason: '管理员将你移出语音，60 秒后可重新加入' }); }
    else if (req.body.action === 'mute' || req.body.action === 'unmute') {
      p.serverMuted = req.body.action === 'mute'; p.moderation.muted = p.serverMuted;
      // 与信令操作串行，防止 produce/resume 与管理员禁言交错。
      p.queue = p.queue.then(async () => { if (p.producer) { if (p.serverMuted || p.muted) await p.producer.pause(); else await p.producer.resume(); } publish(); }).catch(() => {});
    } else throw fail('操作无效');
    res.json({ ok: true });
  });
  app.use(express.static(config.staticDir, { etag: true }));
  app.use((error, req, res, next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? '服务器暂时不可用' : error.message });
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/ws' || req.headers.origin !== config.origin) throw fail('拒绝连接');
      rate(`ws:${ip(req)}`, 30);
      const user = store.session(cookie(req));
      if (!user || peers.size >= config.maxConnections) throw fail('未登录或连接已满');
      const old = peers.get(user.id);
      if (old) { leave(old); old.ws.close(4001, '已在另一个页面打开'); }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, user, cookie(req)));
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  const transportInfo = t => ({ id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters });
  function iceServers(userId) {
    if (!config.turnUrls?.length) return [];
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
    return [{ urls: config.turnUrls, username, credential: createHmac('sha1', config.turnSecret).update(username).digest('base64') }];
  }
  async function rpc(p, op, d) {
    if (op === 'chat') {
      rate(`chat:${p.user.id}`, 25, 10000);
      const id = positiveId(d.channelId);
      if (store.channel(id)?.kind !== 'text') throw fail('文字频道不存在');
      const message = store.addMessage(id, p.user, text(d.body, 1, 2000)); broadcast('message', message); return message;
    }
    if (op === 'join') {
      const id = positiveId(d.roomId);
      if (store.channel(id)?.kind !== 'voice') throw fail('语音频道不存在');
      if (p.moderation.kickedUntil > Date.now()) throw fail('请稍后重新加入');
      if (p.room === id) throw fail('已经在频道中');
      const others = [...peers.values()].filter(x => x !== p && x.room);
      if (others.length >= config.maxVoice || others.filter(x => x.room === id).length >= config.maxRoom) throw fail('语音人数已满');
      leave(p); p.room = id; publish();
      return { rtpCapabilities: media.capabilities, iceServers: iceServers(p.user.id) };
    }
    if (op === 'leave') { leave(p); return {}; }
    if (!p.room) throw fail('请先加入语音频道');
    if (op === 'transport') {
      if (!['send', 'recv'].includes(d.direction)) throw fail('传输方向无效');
      if ([...p.transports.values()].some(t => t.appData.direction === d.direction)) throw fail('重复创建传输');
      const room = p.room, t = await media.transport(d.direction);
      if (p.room !== room || p.ws.readyState !== WebSocket.OPEN) { t.close(); throw fail('连接已结束'); }
      p.transports.set(t.id, t);
      t.on('dtlsstatechange', state => { if (state === 'closed') { leave(p); send(p, 'voiceEnded', { reason: '语音连接中断，请重新加入' }); } });
      return transportInfo(t);
    }
    if (op === 'connect') {
      const t = p.transports.get(d.transportId); if (!t) throw fail('传输不存在');
      await t.connect({ dtlsParameters: d.dtlsParameters }); return {};
    }
    if (op === 'produce') {
      const t = p.transports.get(d.transportId);
      if (!t || t.appData.direction !== 'send' || p.producer || d.kind !== 'audio') throw fail('只允许一路语音');
      const room = p.room;
      const producer = await t.produce({ kind: 'audio', rtpParameters: d.rtpParameters, paused: p.muted || p.serverMuted });
      if (p.room !== room || p.ws.readyState !== WebSocket.OPEN) { producer.close(); throw fail('连接已结束'); }
      p.producer = producer;
      for (const other of peers.values()) if (other !== p && other.room === p.room) send(other, 'producer', { producerId: producer.id, userId: p.user.id });
      return { id: producer.id };
    }
    if (op === 'producers') return [...peers.values()].filter(x => x !== p && x.room === p.room && x.producer).map(x => ({ producerId: x.producer.id, userId: x.user.id }));
    if (op === 'consume') {
      const source = [...peers.values()].find(x => x !== p && x.room === p.room && x.producer?.id === d.producerId);
      const t = p.transports.get(d.transportId);
      if (!source || !t || t.appData.direction !== 'recv' || !media.canConsume(d.producerId, d.rtpCapabilities)) throw fail('音频已结束或设备不支持');
      if ([...p.consumers.values()].some(c => c.producerId === d.producerId)) throw fail('已经订阅此音频');
      const room = p.room;
      const c = await t.consume({ producerId: d.producerId, rtpCapabilities: d.rtpCapabilities, paused: true });
      if (p.room !== room || p.ws.readyState !== WebSocket.OPEN) { c.close(); throw fail('连接已结束'); }
      p.consumers.set(c.id, c);
      c.on('producerclose', () => { p.consumers.delete(c.id); send(p, 'producerClosed', { producerId: c.producerId }); });
      return { id: c.id, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters, userId: source.user.id };
    }
    if (op === 'resume') { const c = p.consumers.get(d.consumerId); if (!c) throw fail('音频已结束'); await c.resume(); return {}; }
    if (op === 'mute') {
      p.muted = !!d.muted; p.deafened = !!d.deafened;
      if (p.producer) { if (p.muted || p.serverMuted) await p.producer.pause(); else await p.producer.resume(); }
      publish(); return {};
    }
    throw fail('未知操作');
  }
  wss.on('connection', (ws, user, token) => {
    if (!moderation.has(user.id)) moderation.set(user.id, { muted: false, kickedUntil: 0 });
    const mod = moderation.get(user.id);
    const p = { ws, user, token, room: null, muted: false, deafened: false, serverMuted: mod.muted, moderation: mod, transports: new Map(), consumers: new Map(), producer: null, queue: Promise.resolve(), pending: 0, alive: true };
    peers.set(user.id, p); publish();
    ws.on('pong', () => { p.alive = true; });
    ws.on('error', () => {});
    ws.on('message', bytes => {
      let request;
      try { rate(`rpc:${user.id}`, 180, 10000); request = JSON.parse(bytes.toString()); if (!Number.isSafeInteger(request.id) || typeof request.op !== 'string' || !request.data || typeof request.data !== 'object') throw fail('信令格式无效'); } catch { return ws.close(1008, '无效或过于频繁的请求'); }
      if (++p.pending > 30) return ws.close(1008, '请求积压');
      p.queue = p.queue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN || peers.get(user.id) !== p) return;
        if (!store.session(token)) return ws.close(4001, '登录已过期');
        try { const data = await rpc(p, request.op, request.data); send(p, 'reply', { id: request.id, result: data }); }
        catch (error) { send(p, 'reply', { id: request.id, error: error.status ? error.message : '语音操作失败，请重新加入频道' }); }
      }).catch(console.error).finally(() => { p.pending--; });
    });
    ws.on('close', () => { if (peers.get(user.id) === p) peers.delete(user.id); leave(p); });
  });
  const timer = setInterval(() => {
    for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
    for (const p of peers.values()) { if (!p.alive || !store.session(p.token)) { p.ws.terminate(); continue; } p.alive = false; p.ws.ping(); }
  }, 30000);
  timer.unref();
  return { app, server, store, async close() {
    clearInterval(timer);
    const current = [...peers.values()]; for (const p of current) p.ws.terminate();
    await Promise.all(current.map(p => p.queue));
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    media.close(); store.close();
  } };
}
