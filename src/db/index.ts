import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH || './data/ai-mesh.db';

// Ensure directory exists
mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });

const db = new Database(resolve(DB_PATH));

// Performance: WAL mode + foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export default db;
