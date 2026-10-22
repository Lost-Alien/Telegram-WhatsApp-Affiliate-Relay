import 'dotenv/config';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
const config=readConfig();
const store=new Store(path.join(config.dataDir,'relay.sqlite'),config.maxQueued);
console.log(`${store.retryFailed()} failed posts queued for retry`);
store.close();
