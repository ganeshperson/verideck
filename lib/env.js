// Load .env (KEY=value lines) into process.env without overriding real env vars.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
