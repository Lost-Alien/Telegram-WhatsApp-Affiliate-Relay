import { TelegramClient, Api, utils, Logger } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { NewMessage } from 'teleproto/events';
import QRCode from 'qrcode';
import path from 'node:path';
import { statSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { telegramText } from './affiliate.js';

export function sourceName(value) {
  const name = value.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/$/, '');
  if (!/^([A-Za-z][A-Za-z0-9_]{3,31}|-100\d+)$/.test(name)) throw new Error('Use a public @channel username or a -100 channel ID');
  return name;
}

export function snapshot(message) {
  const document = message.document;
  const mime = document?.mimeType || (message.photo ? 'image/jpeg' : '');
  const kind = message.photo || mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
  const size = Number(document?.size?.toString() || message.file?.size || 0);
  return {text:telegramText(message), media:kind ? {kind,mime,size} : null};
}

export class Telegram {
  constructor(config, store, logger, wake) {
    Object.assign(this, {config, store, logger, wake});
    this.ready = false; this.status = 'waiting'; this.qr = null; this.entities = new Map(); this.stopping = false;
  }
  async start() {
    if (!this.config.apiId || !this.config.apiHash) { this.status = 'Telegram API credentials required in .env'; return; }
    if (!this.config.sources.length) { this.status = 'Source channels required in .env'; return; }
    const session = new StringSession(this.store.get('telegramSession', ''));
    const log = new Logger('error');
    this.client = new TelegramClient(session, this.config.apiId, this.config.apiHash, {
      connectionRetries:5, autoReconnect:true, floodSleepThreshold:30, baseLogger:log,
      maxConcurrentDownloads:1, downloadPool:{workers:1}, deviceModel:'Telegram WhatsApp Relay', appVersion:'1.0.0'
    });
    this.status = 'connecting';
    await this.client.connect();
    if (!(await this.client.checkAuthorization())) {
      this.status = 'scan QR in Telegram Settings > Devices';
      await this.client.signInUserWithQrCode({apiId:this.config.apiId,apiHash:this.config.apiHash}, {
        qrCode:async ({token}) => { this.qr = await QRCode.toDataURL(`tg://login?token=${token.toString('base64url')}`, {width:280,margin:2}); },
        password:async () => {
          this.qr = null; this.status = 'Telegram account requests its existing two-step verification password';
          return new Promise((resolve, reject) => {
            this.passwordResolve = resolve; this.passwordReject = reject;
            this.passwordTimer = setTimeout(() => { this.passwordResolve = null; reject(new Error('Telegram two-step verification timed out')); }, 300000);
          });
        },
        onError:async error => { this.error = error.message; this.logger.warn({error:error.message},'Telegram pairing needs attention'); return true; }
      });
      this.store.set('telegramSession', this.client.session.save());
    }
    if (this.stopping) return;
    this.qr = null;
    for (const source of this.config.sources) {
      const name = sourceName(source);
      const entity = await this.client.getEntity(name);
      if (!(entity instanceof Api.Channel) || !entity.broadcast) throw new Error(`${source} is not a Telegram broadcast channel`);
      // Membership enables pushed channel updates; this only uses the relay's independent login.
      if (entity.left) await this.client.invoke(new Api.channels.JoinChannel({channel:entity}));
      const id = utils.getPeerId(entity).toString();
      this.entities.set(id, {entity,name});
      const cursorKey = `cursor:${id}`;
      if (this.store.get(cursorKey) === null) {
        const messages = await this.client.getMessages(entity, {limit:1});
        this.store.set(cursorKey, messages[0]?.id || 0);
      }
    }
    this.client.addEventHandler(event => {
      const id = event.chatId?.toString();
      if (!this.entities.has(id) || this.stopping) return;
      try { this.capture(id, event.message); }
      catch (error) { this.error = error.message; this.logger.warn({error:error.message},'Live post deferred to channel recovery'); }
    }, new NewMessage({incoming:true}));
    this.status = 'connected'; this.ready = true; this.error = null;
    this.logger.info({sources:this.config.sources},'Telegram sources connected');
    await this.startRecovery();
  }
  async startRecovery() {
    // A full outbox or temporary channel error must never stop delivery of accepted jobs.
    this.wake();
    try { await this.reconcile(); }
    catch (error) { this.error=error.message; this.logger.warn({error:error.message},'Initial channel recovery delayed'); }
    this.recoveryTimer = setInterval(() => this.reconcile().catch(error => { this.error = error.message; this.logger.warn({error:error.message},'Channel recovery delayed'); }), 30000);
  }
  providePassword(password) {
    if (!this.passwordResolve) throw new Error('Telegram is not waiting for two-step verification');
    clearTimeout(this.passwordTimer);
    this.passwordResolve(password); this.passwordResolve = null;
  }
  capture(id, message) {
    if (!(message instanceof Api.Message)) return;
    if (message.noforwards || message.media?.ttlSeconds) {
      if (this.store.enqueue(id,message.id,{text:''})) this.store.skipped(`${id}:${message.id}`,'Source content is protected or expiring');
      return;
    }
    const payload = snapshot(message);
    if (!payload.text && !payload.media) return;
    if (this.store.enqueue(id, message.id, payload)) this.wake();
  }
  async reconcile() {
    if (this.reconciling || this.stopping) return;
    this.reconciling = true;
    try {
      for (const [id, {entity}] of this.entities) {
        // Bounded catch-up; new live posts still enter the outbox immediately.
        const cursorKey = `cursor:${id}`;
        const messages = await this.client.getMessages(entity, {minId:this.store.get(cursorKey,0), reverse:true, limit:100});
        for (const message of messages) {
          if (this.stopping) return;
          this.capture(id, message);
          this.store.set(cursorKey, message.id);
        }
      }
    } finally { this.reconciling = false; }
  }
  async download(job) {
    const meta = job.payload.media;
    if (!meta) return null;
    if (meta.size > this.config.maxMediaBytes) {
      this.logger.warn({post:job.id,size:meta.size},'Media exceeds configured bound; forwarding its text and links');
      return null;
    }
    const source = this.entities.get(job.chat);
    if (!source) throw new Error('Source channel is unavailable');
    const messages = await this.client.getMessages(source.entity, {ids:[job.message]});
    if (!messages[0]) throw new Error('Source media is no longer available');
    const folder = path.join(this.config.dataDir,'media');
    await mkdir(folder, {recursive:true,mode:0o700});
    const destination = path.join(folder, job.wa_id + (meta.kind === 'video' ? '.mp4' : '.jpg'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const progress = () => {
        // Some photo updates have no declared size. Bound the actual disk download too.
        try { if (statSync(destination).size > this.config.maxMediaBytes) controller.abort(); } catch { /* first chunk */ }
      };
      await this.client.downloadMedia(messages[0], {outputFile:destination, signal:controller.signal,requestTimeout:15000,progressCallback:progress});
      const info = await stat(destination);
      if (info.size > this.config.maxMediaBytes) { await rm(destination,{force:true}); return null; }
      return {path:destination, kind:meta.kind, mime:meta.mime};
    } catch (error) { await rm(destination,{force:true}); throw error; }
    finally { clearTimeout(timer); }
  }
  async cleanup(media) { await rm(media.path,{force:true}); }
  async stop() {
    this.stopping = true; this.ready = false;
    clearInterval(this.recoveryTimer); clearTimeout(this.passwordTimer);
    this.passwordReject?.(new Error('Relay stopping'));
    await this.client?.disconnect();
  }
}
