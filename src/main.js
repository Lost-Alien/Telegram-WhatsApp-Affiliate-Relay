import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { AffiliateConverter } from './affiliate.js';
import { Telegram } from './telegram.js';
import { WhatsApp } from './whatsapp.js';
import { Relay } from './relay.js';
import { dashboard } from './dashboard.js';

process.umask(0o077);
const config = readConfig();
const logger = pino({level:config.logLevel,redact:['*.apiHash','*.cueKey','*.password','*.token']});
const store = new Store(path.join(config.dataDir,'relay.sqlite'), config.maxQueued);
let relay;
const wake = () => relay?.wake();
const telegram = new Telegram(config,store,logger,wake);
const whatsapp = new WhatsApp(config,store,logger,wake);
relay = new Relay({store,converter:new AffiliateConverter(config),telegram,whatsapp,logger});
const server = await dashboard(config, () => ({
  ready:telegram.ready && whatsapp.ready, sources:config.sources,target:config.target,
  telegram:{status:telegram.status,qr:telegram.qr,error:telegram.error},
  whatsapp:{status:whatsapp.status,qr:whatsapp.qr,error:whatsapp.error},
  queue:store.stats(), ramMiB:Math.round(process.memoryUsage().rss/1048576),uptimeSeconds:Math.round(process.uptime())
}),telegram);
let stopping = false;
const pruneTimer = setInterval(() => store.prune(),3600000);
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  clearInterval(pruneTimer);
  const watchdog = setTimeout(() => process.exit(code || 1),20000);
  watchdog.unref();
  logger.info('Relay stopping');
  server.close();
  whatsapp.stop();
  await relay.stop();
  await telegram.stop();
  store.close();
  process.exit(code);
}
whatsapp.onFatal = error => { logger.fatal({err:error},'Relay failed'); stop(1); };
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
process.on('uncaughtException', error => { logger.fatal({err:error},'Uncaught exception'); stop(1); });
process.on('unhandledRejection', error => { logger.fatal({err:error},'Unhandled rejection'); stop(1); });
logger.info({port:config.port,sources:config.sources,target:config.target},'Independent relay started');
telegram.start().catch(error => { telegram.ready=false;telegram.status='Telegram connection needs attention';telegram.error=error.message;logger.error({error:error.message},'Telegram setup failed'); });
whatsapp.start().catch(error => { whatsapp.status='WhatsApp connection needs attention';whatsapp.error=error.message;logger.error({error:error.message},'WhatsApp setup failed'); });
relay.wake();
