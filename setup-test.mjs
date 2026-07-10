import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';
import nacl from 'tweetnacl';

const db = new Database('/tmp/ai-mesh-test.db');
const userId = 'test-user-001';
const username = 'testagent';
const pair = nacl.sign.keyPair();
const publicKey = Buffer.from(pair.publicKey).toString('hex');
const hashId = createHash('sha256').update(username + ':' + publicKey).digest('hex').slice(0, 32);

db.prepare('INSERT OR REPLACE INTO users (id, username, hash_id, public_key) VALUES (?,?,?,?)').run(userId, username, hashId, publicKey);

const groupId = 'test-group-001';
const inviteCode = randomBytes(12).toString('base64url');
db.prepare('INSERT OR REPLACE INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?,?,?,?,?,?)').run(groupId, 'Test Group', 'For testing', inviteCode, userId, 'team');
db.prepare('INSERT OR REPLACE INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)').run('gm-1', groupId, userId, 'admin');

const ts = Date.now().toString(36);
const nonce = randomBytes(8).toString('hex');
const payload = userId + ':' + ts + ':' + nonce;
const hmac = createHash('sha256').update(payload + ':test-secret-123').digest('hex');
const token = Buffer.from(payload + ':' + hmac).toString('base64url');

console.log('TOKEN=' + token);
console.log('USER_ID=' + userId);
console.log('GROUP_ID=' + groupId);
console.log('INVITE_CODE=' + inviteCode);
db.close();
