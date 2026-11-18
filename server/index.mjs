import { resolve } from 'node:path';
import { createMedia } from './media.mjs';
import { createApplication } from './app.mjs';
const int = (name, fallback, max) => {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`${name} 配置无效`);
  return n;
};
const production = process.env.NODE_ENV === 'production';
const config = {
  production, origin: process.env.PUBLIC_ORIGIN || 'http://localhost:3000',
  host: process.env.HOST || '127.0.0.1', port: int('PORT', 3000, 65535),
  rtcListenIp: process.env.RTC_LISTEN_IP || '0.0.0.0', rtcAddress: process.env.RTC_ANNOUNCED_ADDRESS || '127.0.0.1', rtcPort: int('RTC_PORT', 40000, 65535),
  adminName: process.env.ADMIN_USERNAME || 'admin', adminPassword: process.env.ADMIN_PASSWORD || '', invite: process.env.INVITE_CODE || '',
  maxVoice: int('MAX_VOICE_USERS', 8, 50), maxRoom: int('MAX_ROOM_USERS', 8, 50), maxConnections: int('MAX_CONNECTIONS', 40, 200), maxUsers: int('MAX_USERS', 100, 10000),
  database: resolve(process.env.DATA_DIR || 'data', 'echo.sqlite'), staticDir: resolve('dist'),
  turnUrls: (process.env.TURN_URLS || '').split(',').filter(Boolean), turnSecret: process.env.TURN_SECRET || ''
};
if (config.adminPassword.length < 12 || config.invite.length < 12 || /replace-with/.test(config.adminPassword + config.invite)) throw Error('请在 .env 设置至少 12 位的 ADMIN_PASSWORD 和 INVITE_CODE，不能使用示例值。');
if (production && (!config.origin.startsWith('https://') || config.rtcAddress === '127.0.0.1')) throw Error('生产环境需要 HTTPS 域名和公网 RTC_ANNOUNCED_ADDRESS。');
if (config.turnUrls.length && !config.turnSecret) throw Error('TURN_URLS 需要配合 TURN_SECRET。');
const media = await createMedia(config);
const app = await createApplication(config, media);
app.server.listen(config.port, config.host, () => console.log(`Echo Room: ${config.origin} | SFU ${config.rtcPort}/udp+tcp | limit ${config.maxVoice}`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
