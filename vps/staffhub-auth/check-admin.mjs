// staffhub-auth — verifica nº de admins (usado pelo deploy para decidir o seed).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

const db = new DatabaseSync(config.dbPath, { readOnly: true });
console.log(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n);
