import { Device } from 'mediasoup-client';
const $ = selector => document.querySelector(selector);
const state = { user: null, channels: [], people: [], selected: null, room: null, socket: null, pending: new Map(), next: 0, voice: null, register: false, joining: false, closing: false, maxVoice: 8, reconnect: null };
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function el(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content != null) node.textContent = content; return node; }
const avatar = name => el('div', 'avatar', [...name][0].toUpperCase());
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json(); if (!res.ok) throw Error(data.error || '请求失败'); return data;
}
function rpc(op, data = {}) {
  return new Promise((resolve, reject) => {
    if (state.socket?.readyState !== WebSocket.OPEN) return reject(Error('连接已断开，请等待重连'));
    const id = ++state.next;
    const timer = setTimeout(() => { state.pending.delete(id); reject(Error('请求超时，请重试')); }, 15000);
    state.pending.set(id, { resolve, reject, timer }); state.socket.send(JSON.stringify({ id, op, data }));
  });
}
function connect() {
  clearTimeout(state.reconnect);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); state.socket = ws;
  ws.onopen = () => { $('#socket-status').textContent = '在线'; renderVoice(); if (state.selected?.kind === 'text') loadMessages().catch(error => toast(error.message)); };
  ws.onmessage = event => {
    const { event: type, data } = JSON.parse(event.data);
    if (type === 'reply') { const p = state.pending.get(data.id); if (p) { clearTimeout(p.timer); state.pending.delete(data.id); data.error ? p.reject(Error(data.error)) : p.resolve(data.result); } return; }
    if (type === 'presence') { state.people = data; renderPeople(); renderChannels(); renderVoice(); }
    if (type === 'channels') { state.channels = data; if (!data.some(c => c.id === state.selected?.id)) selectChannel(data.find(c => c.kind === 'text')); renderChannels(); }
    if (type === 'message' && state.selected?.id === data.channel_id) { addMessage(data); scrollBottom(); }
    if (type === 'producer') consume(data).catch(error => toast(error.message));
    if (type === 'producerClosed') removeConsumer(data.producerId);
    if (type === 'voiceEnded') { cleanupVoice(); toast(data.reason); }
  };
  ws.onclose = event => {
    if (state.socket !== ws) return;
    for (const p of state.pending.values()) { clearTimeout(p.timer); p.reject(Error('连接已断开')); } state.pending.clear();
    cleanupVoice(); state.people = []; renderPeople(); renderChannels(); $('#socket-status').textContent = '连接断开';
    if (state.closing) return;
    if (event.code === 4001) { state.closing = true; $('#workspace').hidden = true; $('#auth-screen').hidden = false; $('#auth-error').textContent = event.reason || '请重新登录'; return; }
    toast('连接中断，正在重连；语音需要重新加入');
    state.reconnect = setTimeout(() => api('/bootstrap').then(() => connect()).catch(() => { $('#workspace').hidden = true; $('#auth-screen').hidden = false; }), 3000);
  };
}
async function boot() {
  const data = await api('/bootstrap'); Object.assign(state, { user: data.user, channels: data.channels, maxVoice: data.maxVoice, closing: false });
  $('#auth-screen').hidden = true; $('#workspace').hidden = false; $('#self-name').textContent = data.user.username; $('#self-avatar').textContent = [...data.user.username][0];
  document.querySelectorAll('.add-channel').forEach(b => { b.hidden = data.user.role !== 'admin'; });
  renderChannels(); await selectChannel(data.channels.find(c => c.kind === 'text')); connect();
}
function renderChannels() {
  for (const kind of ['text', 'voice']) {
    const root = $(`#${kind}-channels`); root.replaceChildren();
    for (const c of state.channels.filter(c => c.kind === kind)) {
      const row = el('div', `channel-row${state.selected?.id === c.id ? ' selected' : ''}`);
      const button = el('button', 'channel-button'); button.append(el('span', '', kind === 'text' ? '#' : '◖'), el('span', '', c.name));
      const members = state.people.filter(p => p.room === c.id);
      if (kind === 'voice') button.append(el('span', 'channel-count', `${members.length}`));
      button.onclick = () => selectChannel(c).catch(error => toast(error.message)); row.append(button);
      if (state.user?.role === 'admin') { const del = el('button', 'delete-channel', '×'); del.title = `删除 ${c.name}`; del.onclick = async () => { if (!confirm(`删除「${c.name}」及其消息？`)) return; try { await api(`/channels/${c.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message); } }; row.append(del); }
      root.append(row);
      if (members.length) { const mini = el('div', 'room-mini'); members.forEach(p => mini.append(el('span', '', `${p.muted || p.serverMuted ? '· ' : ''}${p.username}`))); root.append(mini); }
    }
  }
}
async function selectChannel(channel) {
  if (!channel) return;
  state.selected = channel; $('#workspace').classList.remove('menu-open'); renderChannels();
  $('#channel-symbol').textContent = channel.kind === 'text' ? '#' : '◖'; $('#channel-name').textContent = channel.name;
  $('#channel-description').textContent = channel.kind === 'text' ? '分享日常，让话题自然发生' : '熟悉的声音，就在这里';
  $('#text-panel').hidden = channel.kind !== 'text'; $('#voice-panel').hidden = channel.kind !== 'voice';
  if (channel.kind === 'text') { $('#welcome-title').textContent = `这里是 # ${channel.name}`; $('#message-input').placeholder = `发消息到 # ${channel.name}`; await loadMessages(); } else renderVoice();
}
function addMessage(m, prepend = false) {
  if ($(`#message-${m.id}`)) return;
  const row = el('article', 'message'); row.id = `message-${m.id}`; row.dataset.id = m.id;
  const content = el('div', 'message-content'); const header = el('div');
  header.append(el('span', 'message-name', m.username), el('time', 'message-time', new Date(m.created).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })));
  content.append(header, el('p', 'message-body', m.body)); row.append(avatar(m.username), content);
  prepend ? $('#messages').prepend(row) : $('#messages').append(row);
}
let messageLoad = 0;
async function loadMessages(older = false) {
  if (state.selected?.kind !== 'text') return;
  const id = state.selected.id, generation = ++messageLoad;
  const before = older ? $('#messages').firstElementChild?.dataset.id : null;
  if (!older) $('#messages').replaceChildren();
  const messages = await api(`/channels/${id}/messages${before ? `?before=${before}` : ''}`);
  if (state.selected.id !== id || generation !== messageLoad) return;
  if (older) { const height = $('#message-scroll').scrollHeight; [...messages].reverse().forEach(m => addMessage(m, true)); $('#message-scroll').scrollTop += $('#message-scroll').scrollHeight - height; }
  else { messages.forEach(m => addMessage(m)); [...$('#messages').children].sort((a,b) => Number(a.dataset.id)-Number(b.dataset.id)).forEach(n => $('#messages').append(n)); scrollBottom(); }
  $('#load-older').hidden = messages.length < 50;
}
function scrollBottom() { $('#message-scroll').scrollTop = $('#message-scroll').scrollHeight; }
function renderPeople() {
  $('#online-count').textContent = state.people.length; $('#online-members').replaceChildren();
  for (const p of state.people) {
    const row = el('div', 'member'), details = el('div', 'member-details');
    details.append(el('strong', '', p.username), el('small', '', p.room ? `◖ ${state.channels.find(c => c.id === p.room)?.name || '语音中'}` : p.role === 'admin' ? '空间管理员' : '在线，随时聊聊'));
    row.append(avatar(p.username), details, el('span', 'member-status')); $('#online-members').append(row);
  }
}
function renderVoice() {
  const own = state.people.find(p => p.id === state.user?.id), v = state.voice;
  $('#mute').classList.toggle('active', !!v?.muted || !!own?.serverMuted); $('#deafen').classList.toggle('active', !!v?.deafened);
  $('#mute').disabled = !v || !!own?.serverMuted; $('#deafen').disabled = !v;
  $('#mute').setAttribute('aria-pressed', String(!!v?.muted || !!own?.serverMuted)); $('#deafen').setAttribute('aria-pressed', String(!!v?.deafened));
  $('#voice-status').hidden = !state.room;
  $('#voice-status-room').textContent = state.channels.find(c => c.id === state.room)?.name || '';
  $('#voice-status-title').textContent = state.joining ? '正在连接语音' : '已加入语音';
  if (state.selected?.kind !== 'voice') return;
  $('#voice-title').textContent = state.selected.name;
  const members = state.people.filter(p => p.room === state.selected.id); $('#voice-members').replaceChildren();
  for (const p of members) {
    const card = el('div', 'voice-card'); card.dataset.userId = p.id;
    card.append(avatar(p.username), el('strong', '', `${p.username}${p.id === state.user.id ? '（你）' : ''}`), el('small', '', p.serverMuted ? '管理员已禁言' : p.muted ? '麦克风已静音' : '麦克风已开启'));
    if (state.user.role === 'admin' && p.id !== state.user.id) { const controls = el('div', 'moderation'); for (const [action, label] of [[p.serverMuted ? 'unmute' : 'mute', p.serverMuted ? '解除禁言' : '禁言'], ['kick', '移出']]) { const b = el('button', '', label); b.onclick = () => api('/moderate', { method: 'POST', body: JSON.stringify({ userId: p.id, action }) }).catch(e => toast(e.message)); controls.append(b); } card.append(controls); }
    $('#voice-members').append(card);
  }
  $('#voice-empty').hidden = members.length > 0;
  $('#join-voice').textContent = state.joining ? '正在连接…' : state.room === state.selected.id ? '离开语音频道' : state.room ? '切换到这个频道 →' : '加入语音频道 →';
  $('#join-voice').disabled = state.joining || state.socket?.readyState !== WebSocket.OPEN;
  $('#voice-hint').textContent = `仅语音 · 全站最多 ${state.maxVoice} 人同时加入 · 戴上耳机会更清晰`;
}
function removeConsumer(producerId) {
  const v = state.voice, item = v?.consumers.get(producerId); if (!item) return;
  item.consumer.close(); item.audio.srcObject = null; item.audio.remove(); item.source?.disconnect(); item.analyser?.disconnect(); item.silent?.disconnect(); v.consumers.delete(producerId);
}
function cleanupVoice() {
  const v = state.voice; state.voice = null; state.room = null; state.joining = false;
  if (v) { cancelAnimationFrame(v.frame); for (const c of v.consumers.values()) { c.consumer.close(); c.audio.srcObject = null; c.audio.remove(); } v.send?.close(); v.recv?.close(); v.stream?.getTracks().forEach(t => t.stop()); v.context?.close().catch(() => {}); }
  $('#audio-container').replaceChildren(); $('#enable-audio').hidden = true; renderVoice();
}
function meter(v, stream) {
  if (!v.context) return {};
  const source = v.context.createMediaStreamSource(stream), analyser = v.context.createAnalyser(), silent = v.context.createGain(); analyser.fftSize = 256; silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(v.context.destination); return { source, analyser, silent, buffer: new Uint8Array(analyser.frequencyBinCount) };
}
function tick(v) {
  if (state.voice !== v) return;
  const items = [{ ...v.meter, userId: state.user.id }, ...v.consumers.values()];
  for (const item of items) {
    if (!item.analyser) continue; item.analyser.getByteFrequencyData(item.buffer);
    const person = state.people.find(p => p.id === item.userId);
    const speaking = !person?.muted && !person?.serverMuted && item.buffer.reduce((a,b) => a+b, 0) / item.buffer.length > 10;
    $(`.voice-card[data-user-id="${item.userId}"]`)?.classList.toggle('speaking', speaking);
  }
  v.frame = requestAnimationFrame(() => tick(v));
}
async function consume(info) {
  const v = state.voice;
  if (!v?.recv || v.consumers.has(info.producerId) || v.loading.has(info.producerId)) return;
  v.loading.add(info.producerId);
  try {
    const params = await rpc('consume', { transportId: v.recv.id, producerId: info.producerId, rtpCapabilities: v.device.rtpCapabilities });
    if (state.voice !== v) return;
    const consumer = await v.recv.consume(params);
    if (state.voice !== v) { consumer.close(); return; }
    const stream = new MediaStream([consumer.track]), audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = stream; audio.muted = v.deafened; $('#audio-container').append(audio);
    v.consumers.set(info.producerId, { consumer, audio, userId: params.userId, ...meter(v, stream) });
    await rpc('resume', { consumerId: consumer.id });
    audio.play().catch(() => { $('#enable-audio').hidden = false; });
  } finally { v.loading.delete(info.producerId); }
}
async function leaveVoice() { try { if (state.room) await rpc('leave'); } finally { cleanupVoice(); } }
async function joinVoice() {
  if (state.joining) return;
  const channel = state.selected;
  if (channel?.kind !== 'voice') return;
  if (state.room === channel.id) return leaveVoice();
  if (!window.isSecureContext || !navigator.mediaDevices) throw Error('语音需要 HTTPS（本机可使用 localhost）');
  if (state.room) await leaveVoice();
  state.joining = true; renderVoice();
  const v = { consumers: new Map(), loading: new Set(), muted: false, deafened: false }; state.voice = v;
  const check = () => { if (state.voice !== v) throw Error('语音连接已取消'); };
  try {
    v.context = new AudioContext(); await v.context.resume(); check();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    if (state.voice !== v) { stream.getTracks().forEach(t => t.stop()); return; } v.stream = stream;
    const joined = await rpc('join', { roomId: channel.id }); check(); state.room = channel.id;
    v.device = new Device(); await v.device.load({ routerRtpCapabilities: joined.rtpCapabilities }); check();
    for (const direction of ['recv', 'send']) {
      const params = await rpc('transport', { direction }); check();
      const t = direction === 'send' ? v.device.createSendTransport({ ...params, iceServers: joined.iceServers }) : v.device.createRecvTransport({ ...params, iceServers: joined.iceServers }); v[direction] = t;
      t.on('connect', ({ dtlsParameters }, ok, bad) => rpc('connect', { transportId: t.id, dtlsParameters }).then(ok, bad));
      if (direction === 'send') t.on('produce', ({ kind, rtpParameters }, ok, bad) => rpc('produce', { transportId: t.id, kind, rtpParameters }).then(ok, bad));
      t.on('connectionstatechange', status => { if (status === 'failed' && state.voice === v) { leaveVoice().catch(() => {}); toast('语音网络连接失败，请检查服务器媒体端口或配置 TURN'); } });
    }
    v.producer = await v.send.produce({ track: v.stream.getAudioTracks()[0], codecOptions: { opusStereo: false, opusDtx: true, opusFec: true, opusMaxAverageBitrate: 32000 } }); check();
    const producers = await rpc('producers'); check(); await Promise.all(producers.map(consume)); check();
    v.meter = meter(v, v.stream); tick(v); state.joining = false; renderVoice(); toast('已加入语音频道');
  } catch (error) { if (state.voice === v) { await rpc('leave').catch(() => {}); cleanupVoice(); } throw error; }
}
$('#auth-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#auth-submit'); button.disabled = true; $('#auth-error').textContent = '';
  try { await api(`/auth/${state.register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); await boot(); }
  catch (error) { $('#auth-error').textContent = error.message; } finally { button.disabled = false; }
};
$('#auth-toggle').onclick = () => { state.register = !state.register; $('#invite-label').hidden = !state.register; $('#invite-label input').required = state.register; $('#auth-title').textContent = state.register ? '加入这个小空间' : '欢迎回来'; $('#auth-submit').textContent = state.register ? '创建账号 →' : '进入空间 →'; $('#auth-toggle').textContent = state.register ? '返回登录' : '使用邀请码加入'; $('#auth-switch-text').textContent = state.register ? '已经有账号？' : '第一次来这里？'; $('#auth-error').textContent = ''; $('#auth-form [name="password"]').autocomplete = state.register ? 'new-password' : 'current-password'; };
$('#message-form').onsubmit = async event => { event.preventDefault(); const input = $('#message-input'), body = input.value.trim(); if (!body || state.selected?.kind !== 'text') return; const button = $('.send-button'); button.disabled = true; try { await rpc('chat', { channelId: state.selected.id, body }); if (input.value.trim() === body) input.value = ''; } catch (e) { toast(e.message); } finally { button.disabled = false; } };
$('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('.send-button').disabled) $('#message-form').requestSubmit(); } };
$('#load-older').onclick = () => loadMessages(true).catch(e => toast(e.message));
$('#join-voice').onclick = () => joinVoice().catch(e => toast(e.name === 'NotAllowedError' ? '请允许浏览器使用麦克风后重试' : e.message));
$('#disconnect').onclick = () => leaveVoice().catch(e => toast(e.message));
$('#mute').onclick = async () => { const v = state.voice; if (!v?.producer) return; const next = !v.muted; try { await rpc('mute', { muted: next, deafened: v.deafened }); if (state.voice !== v) return; v.muted = next; next ? v.producer.pause() : v.producer.resume(); renderVoice(); } catch (e) { toast(e.message); } };
$('#deafen').onclick = async () => { const v = state.voice; if (!v) return; const next = !v.deafened; try { await rpc('mute', { muted: v.muted, deafened: next }); if (state.voice !== v) return; v.deafened = next; for (const c of v.consumers.values()) c.audio.muted = next; renderVoice(); } catch (e) { toast(e.message); } };
$('#enable-audio').onclick = async () => { try { await state.voice?.context?.resume(); await Promise.all([...state.voice?.consumers.values() || []].map(c => c.audio.play())); $('#enable-audio').hidden = true; } catch { toast('浏览器仍阻止播放，请检查网站声音权限'); } };
$('#logout').onclick = async () => { try { await api('/logout', { method: 'POST' }); state.closing = true; clearTimeout(state.reconnect); cleanupVoice(); state.socket?.close(); state.user = null; $('#workspace').hidden = true; $('#auth-screen').hidden = false; } catch (e) { toast(e.message); } };
$('#mobile-menu').onclick = () => $('#workspace').classList.toggle('menu-open');
document.querySelectorAll('.add-channel').forEach(b => { b.onclick = () => { $('#channel-form').reset(); $('#channel-form select').value = b.dataset.kind; $('#channel-dialog').showModal(); }; });
$('#cancel-channel').onclick = () => $('#channel-dialog').close();
$('#channel-form').onsubmit = async event => { event.preventDefault(); try { await api('/channels', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); $('#channel-dialog').close(); } catch (e) { toast(e.message); } };
window.addEventListener('pagehide', () => { state.closing = true; cleanupVoice(); state.socket?.close(); });
boot().catch(() => { $('#auth-screen').hidden = false; });
