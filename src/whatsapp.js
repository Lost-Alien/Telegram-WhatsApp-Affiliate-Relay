import makeWASocket, { initAuthCreds, BufferJSON, proto, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

export function sqliteAuth(store) {
  const decode = value => value ? JSON.parse(value, BufferJSON.reviver) : null;
  const encode = value => JSON.stringify(value, BufferJSON.replacer);
  const creds = decode(store.authGet('creds', 'main')) || initAuthCreds();
  return {
    state: { creds, keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          let value = decode(store.authGet(type, id));
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value !== null) result[id] = value;
        }
        return result;
      },
      set: async data => store.authSetMany(Object.entries(data).flatMap(([type, values]) => Object.entries(values).map(([id, value]) => [type, id, value == null ? null : encode(value)])))
    } },
    saveCreds: () => store.authSetMany([['creds','main',encode(creds)]])
  };
}

export class WhatsApp {
  constructor(config, store, logger, wake) {
    Object.assign(this, {config, store, logger, wake});
    this.status = 'waiting'; this.ready = false; this.qr = null; this.stopping = false; this.pendingAcks = new Map();
  }
  async start() {
    if (this.stopping) return;
    this.status = 'connecting';
    const auth = sqliteAuth(this.store);
    const sock = this.socket = makeWASocket({ auth:auth.state, logger:this.logger.child({component:'whatsapp'},{level:'warn'}),
      browser:Browsers.ubuntu('Chrome'), syncFullHistory:false,
      shouldSyncHistoryMessage:({syncType}) => [proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA].includes(syncType),
      markOnlineOnConnect:false, generateHighQualityLinkPreview:false, enableAutoSessionRecreation:false,
      connectTimeoutMs:30000, defaultQueryTimeoutMs:30000, keepAliveIntervalMs:30000,
      getMessage: async () => undefined });
    sock.ev.on('creds.update', () => {
      try { auth.saveCreds(); } catch (error) { this.logger.fatal({err:error},'Could not persist WhatsApp identity'); this.onFatal?.(error); }
    });
    sock.ws.on('CB:ack,class:message', node => {
      const pending = this.pendingAcks.get(node.attrs.id);
      if (!pending) return;
      if (node.attrs.error) pending.reject(new Error(`WhatsApp rejected post: ${node.attrs.error}`));
      else pending.resolve();
    });
    sock.ev.on('connection.update', update => {
      if (sock !== this.socket || this.stopping) return;
      this.connectionUpdate(sock, update).catch(error => {
        this.logger.error({err:error},'WhatsApp connection setup failed');
        this.ready = false; this.status = 'channel access failed'; this.error = error.message;
      });
    });
  }
  async connectionUpdate(sock, { connection, qr, lastDisconnect }) {
    if (qr) { this.qr = await QRCode.toDataURL(qr, {width:280,margin:2}); this.status = 'scan QR in WhatsApp linked devices'; }
    if (connection === 'open') {
      this.qr = null; this.error = null;
      const metadata = await sock.newsletterMetadata('jid', this.config.target);
      if (!metadata) throw new Error('Destination WhatsApp channel could not be found');
      if (sock !== this.socket || this.stopping) return;
      const role = String(metadata?.viewer_metadata?.role || metadata?.viewerMetadata?.role || metadata?.role || '').toUpperCase();
      this.channelName = metadata?.name || metadata?.thread_metadata?.name?.text || this.config.target;
      if (role && !['OWNER','ADMIN'].includes(role)) throw new Error('Linked WhatsApp account must be an administrator of the destination channel');
      this.status = 'connected'; this.ready = true; this.reconnectAttempts = 0;
      this.logger.info({target:this.config.target,role:role || 'not supplied'},'WhatsApp channel connected');
      this.wake();
    }
    if (connection === 'close') {
      this.ready = false; this.qr = null;
      for (const pending of this.pendingAcks.values()) pending.reject(new Error('WhatsApp disconnected before acknowledgement'));
      const code = lastDisconnect?.error?.output?.statusCode;
      this.status = code === DisconnectReason.loggedOut ? 'WhatsApp session logged out; restart and scan QR' : 'reconnecting';
      if (code === DisconnectReason.loggedOut) return;
      this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.start().catch(error => this.onFatal?.(error)), Math.min(60000, 2000 * 2 ** Math.min(this.reconnectAttempts - 1, 5)));
    }
  }
  async send(job, text, media) {
    if (!this.ready || this.stopping) throw new Error('WhatsApp is not connected');
    const socket = this.socket;
    let timer;
    const acknowledged = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('WhatsApp did not acknowledge the post within 30 seconds')), 30000);
      this.pendingAcks.set(job.wa_id, { resolve, reject });
    });
    // Attach the rejection handler before sending to avoid an unhandled rejection on disconnect.
    const outcome = acknowledged.then(() => null, error => error);
    try {
      const content = media ? { [media.kind]:{url:media.path}, caption:text, mimetype:media.mime } : { text, linkPreview:null };
      await socket.sendMessage(this.config.target, content, {messageId:job.wa_id});
      const error = await outcome;
      if (error) throw error;
    } finally { clearTimeout(timer); this.pendingAcks.delete(job.wa_id); }
  }
  stop() {
    this.stopping = true; this.ready = false;
    clearTimeout(this.reconnectTimer);
    for (const pending of this.pendingAcks.values()) pending.reject(new Error('Relay is stopping'));
    this.socket?.end(new Error('Relay service stopping'));
  }
}
