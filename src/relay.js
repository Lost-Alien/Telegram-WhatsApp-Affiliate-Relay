export class Relay {
  constructor({store, converter, telegram, whatsapp, logger}) {
    Object.assign(this, {store, converter, telegram, whatsapp, logger});
    this.running = false; this.stopping = false; this.timer = null;
  }
  wake() {
    if (this.stopping || this.running) return;
    clearTimeout(this.timer);
    this.task = this.drain().catch(error => { this.logger.error({err:error},'Outbox worker failed'); });
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopping && this.whatsapp.ready && this.telegram.ready) {
        const job = this.store.next();
        if (!job) break;
        let media;
        try {
          const text = job.converted ?? await this.converter.text(job.payload.text);
          if (job.converted === null) this.store.converted(job.id, text);
          if (job.payload.media) media = await this.telegram.download(job);
          if (!text && !media) { this.store.skipped(job.id, 'Post has no forwardable content'); continue; }
          await this.whatsapp.send(job, text, media);
          this.store.delivered(job.id);
          this.logger.info({post:job.id,latencyMs:Date.now()-job.created},'Post acknowledged by WhatsApp');
        } catch (error) {
          this.store.failed(job.id, error.message, Number(error.seconds || 0) * 1000);
          this.logger.warn({post:job.id,error:error.message},'Post retained for retry');
        } finally { if (media) await this.telegram.cleanup(media); }
      }
    } finally {
      this.running = false;
      if (!this.stopping) this.timer = setTimeout(() => this.wake(), 1000);
    }
  }
  async stop() { this.stopping = true; clearTimeout(this.timer); await this.task; }
}
