import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hash, 'hex'));
}
export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member');
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('text','voice')));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS message_channel ON messages(channel_id,id);`);
  if (db.prepare('SELECT COUNT(*) AS n FROM channels').get().n === 0) db.exec("INSERT INTO channels(id,name,kind) VALUES(1,'闲聊广场','text'),(2,'一起开黑','voice'),(3,'安静自习室','voice')");
  return {
    db,
    userByName: name => db.prepare('SELECT * FROM users WHERE username=?').get(name),
    publicUser: id => db.prepare('SELECT id,username,role FROM users WHERE id=?').get(id),
    addUser(name, password, role = 'member') { return Number(db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(name, password, role).lastInsertRowid); },
    userCount: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    channels: () => db.prepare('SELECT * FROM channels ORDER BY id').all(),
    channel: id => db.prepare('SELECT * FROM channels WHERE id=?').get(id),
    addChannel: (name, kind) => Number(db.prepare('INSERT INTO channels(name,kind) VALUES(?,?)').run(name, kind).lastInsertRowid),
    deleteChannel: id => db.prepare('DELETE FROM channels WHERE id=?').run(id),
    session(token) { return token ? db.prepare('SELECT users.id,username,role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(tokenHash(token), Date.now()) : null; },
    createSession(id) {
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE user_id=? OR expires<?').run(id, Date.now());
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), id, Date.now() + 7 * 86400000);
      return token;
    },
    deleteSession: token => db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(token)),
    messages: (channel, before = Number.MAX_SAFE_INTEGER) => db.prepare('SELECT messages.*,username FROM messages JOIN users ON users.id=user_id WHERE channel_id=? AND messages.id<? ORDER BY messages.id DESC LIMIT 50').all(channel, before).reverse(),
    addMessage(channel, user, body) {
      const created = Date.now();
      const id = Number(db.prepare('INSERT INTO messages(channel_id,user_id,body,created) VALUES(?,?,?,?)').run(channel, user.id, body, created).lastInsertRowid);
      // 每频道保留最近 2000 条，避免小磁盘无限增长。
      db.prepare('DELETE FROM messages WHERE channel_id=? AND id NOT IN (SELECT id FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT 2000)').run(channel, channel);
      return { id, channel_id: channel, user_id: user.id, username: user.username, body, created };
    },
    close: () => db.close()
  };
}
