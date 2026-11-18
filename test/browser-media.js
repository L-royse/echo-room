import { Device } from 'mediasoup-client';
const output = document.querySelector('#result');
const log = value => { output.textContent += `\n${value}`; };
document.querySelector('#run').onclick = async () => {
  document.querySelector('#run').disabled = true; output.textContent = 'RUNNING';
  const resources = [], clients = []; let context;
  try {
    context = new AudioContext(); await context.resume();
    async function client(name) {
      const suffix = Math.random().toString(36).slice(2, 9);
      const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name + suffix, password: 'test-browser-password', invite: 'local-invite-only-12345' }) });
      if (!response.ok) throw Error('注册测试用户失败');
      const ws = new WebSocket(`ws://${location.host}/ws`); clients.push(ws);
      const pending = new Map(); let next = 0;
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.event !== 'reply') return; const p = pending.get(m.data.id); if (p) { clearTimeout(p.timer); pending.delete(m.data.id); m.data.error ? p.reject(Error(m.data.error)) : p.resolve(m.data.result); } };
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const rpc = (op, data = {}) => new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => reject(Error(`超时 ${op}`)), 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, op, data })); });
      const joined = await rpc('join', { roomId: 2 }); const device = new Device(); await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
      async function transport(direction) {
        const data = await rpc('transport', { direction }); const tr = direction === 'send' ? device.createSendTransport(data) : device.createRecvTransport(data); resources.push(tr);
        tr.on('connect', ({ dtlsParameters }, ok, bad) => rpc('connect', { transportId: tr.id, dtlsParameters }).then(ok, bad));
        if (direction === 'send') tr.on('produce', ({ kind, rtpParameters }, ok, bad) => rpc('produce', { transportId: tr.id, kind, rtpParameters }).then(ok, bad));
        return tr;
      }
      return { rpc, device, transport };
    }
    const a = await client('sender'), b = await client('listener');
    const send = await a.transport('send'), recv = await b.transport('recv');
    const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination(); oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
    resources.push({ close: () => { oscillator.stop(); destination.stream.getTracks().forEach(t => t.stop()); } });
    const producer = await send.produce({ track: destination.stream.getAudioTracks()[0], codecOptions: { opusMaxAverageBitrate: 32000 } }); log('PASS: 发送端 ICE/DTLS 已连接，Opus 音频已发布');
    const data = await b.rpc('consume', { transportId: recv.id, producerId: producer.id, rtpCapabilities: b.device.rtpCapabilities });
    const consumer = await recv.consume(data); await b.rpc('resume', { consumerId: consumer.id });
    const remoteStream = new MediaStream([consumer.track]);
    const audio = document.createElement('audio'); audio.muted = true; audio.srcObject = remoteStream; document.body.append(audio); await audio.play(); resources.push({ close: () => { audio.srcObject = null; audio.remove(); } });
    const source = context.createMediaStreamSource(remoteStream); const analyser = context.createAnalyser(); const silent = context.createGain(); silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination); const samples = new Uint8Array(analyser.frequencyBinCount);
    const deadline = Date.now() + 12000; let received = 0, packets = 0, peak = 0;
    while (Date.now() < deadline) {
      const stats = await consumer.getStats(); stats.forEach(s => { if (s.type === 'inbound-rtp') { received = s.bytesReceived || 0; packets = s.packetsReceived || 0; } }); analyser.getByteFrequencyData(samples); peak = Math.max(...samples);
      if (received > 1000 && packets > 10 && peak > 20) break;
      await new Promise(r => setTimeout(r, 150));
    }
    if (received <= 1000 || peak <= 20) { const stats = await consumer.getStats(); stats.forEach(s => { if (s.type === 'inbound-rtp') log(JSON.stringify(s)); }); throw Error(`没有收到有效音频: bytes=${received}, peak=${peak}, context=${context.state}, track=${consumer.track.readyState}, muted=${consumer.track.muted}`); }
    log(`PASS: 接收端收到 ${received} 字节 / ${packets} 个 RTP 包，解码音频峰值 ${peak}`);
    await a.rpc('mute', { muted: true }); log('PASS: 服务端暂停音频');
    await a.rpc('mute', { muted: false }); await a.rpc('leave'); await b.rpc('leave'); log('PASS: 恢复与离开信令完成');
    log('ALL PASSED — 真正经过本机 mediasoup SFU 的 WebRTC 音频传输');
  } catch (error) { log(`FAIL: ${error.stack || error}`); }
  finally { resources.reverse().forEach(r => r.close()); clients.forEach(ws => ws.close()); await context?.close(); document.querySelector('#run').disabled = false; }
};
