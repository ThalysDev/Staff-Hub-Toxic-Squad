import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const target = process.argv[2]
  ? process.argv[2]
  : join(import.meta.dirname, '.probe-ud/Partitions/tw/Network/Cookies');
const db = new DatabaseSync(target, { readOnly: true });
const rows = db.prepare('select host_key, name, path, cast(expires_utc as text) as expires_utc, is_persistent, length(encrypted_value) as elen from cookies').all();
for (const r of rows) console.log(`${r.host_key}  ${r.name}  persist=${r.is_persistent}  enc=${r.elen}`);
console.log('total:', rows.length);
