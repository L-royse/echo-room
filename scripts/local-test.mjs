// 仅用于本地验证；不会包含在生产镜像的运行入口中。
import { createMedia } from '../server/media.mjs';
import { createApplication } from '../server/app.mjs';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const config = { database: ':memory:', staticDir: 'dist', origin: 'http://localhost:3000', adminName: 'admin', adminPassword: 'local-test-only-12345', invite: 'local-invite-only-12345', maxVoice: 8, maxRoom: 8, maxConnections: 40, maxUsers: 100, rtcListenIp: '127.0.0.1', rtcAddress: '127.0.0.1', rtcPort: 40000 };
const media = await createMedia(config), app = await createApplication(config, media);
await build({ entryPoints: ['test/browser-media.js'], outfile: 'artifacts/browser-media.js', bundle: true, format: 'esm' });
app.app.get('/__test__/media', (req, res) => res.type('html').send(readFileSync('test/browser-media.html')));
app.app.get('/__test__/media.js', (req, res) => res.type('js').send(readFileSync('artifacts/browser-media.js')));
app.server.listen(3000, '127.0.0.1', () => console.log('Local test: http://localhost:3000 ; synthetic audio: /__test__/media'));
process.on('SIGINT', async () => { await app.close(); process.exit(); });
process.on('SIGTERM', async () => { await app.close(); process.exit(); });
