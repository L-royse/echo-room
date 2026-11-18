import * as mediasoup from 'mediasoup';
export async function createMedia(config) {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', error => { console.error('语音进程退出', error); process.exit(1); });
  const webRtcServer = await worker.createWebRtcServer({ listenInfos: ['udp', 'tcp'].map(protocol => ({ protocol, ip: config.rtcListenIp, announcedAddress: config.rtcAddress, port: config.rtcPort })) });
  const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
  return {
    capabilities: router.rtpCapabilities,
    async transport(direction) {
      const t = await router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 300000, appData: { direction } });
      await t.setMaxIncomingBitrate(96000);
      return t;
    },
    canConsume: (producerId, rtpCapabilities) => router.canConsume({ producerId, rtpCapabilities }),
    close: () => worker.close()
  };
}
