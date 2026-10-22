import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { sqliteAuth, WhatsApp } from '../src/whatsapp.js';
import { sourceName, Telegram } from '../src/telegram.js';
import { readConfig } from '../src/config.js';
const logger={info(){},warn(){},error(){}};
function fixture(t,max=1000){const folder=mkdtempSync(path.join(os.tmpdir(),'relay-test-'));const filename=path.join(folder,'relay.sqlite');const store=new Store(filename,max);t.after(()=>{try{store.close();}catch{}rmSync(folder,{recursive:true,force:true});});return{store,filename};}

test('durable pending jobs survive restart and duplicates do not enqueue again',t=>{
  let{store,filename}=fixture(t);store.enqueue('-100123',42,{text:'deal'});const id=store.next().wa_id;store.close();
  const reopened=new Store(filename);
  try { assert.equal(reopened.enqueue('-100123',42,{text:'again'}),false);assert.equal(reopened.next().wa_id,id);
    reopened.delivered('-100123:42');assert.equal(reopened.next(),null);assert.equal(reopened.enqueue('-100123',42,{}),false);
  } finally { reopened.close(); }
});
test('full outbox rejects new posts rather than dropping accepted posts',t=>{
  const{store}=fixture(t,1);store.enqueue('one',1,{text:'first'});assert.throws(()=>store.enqueue('two',2,{text:'second'}),/Outbox full/);assert.equal(store.next().payload.text,'first');
});
test('failed posts remain visible and can be explicitly retried',t=>{
  const{store}=fixture(t);store.enqueue('one',1,{});for(let i=0;i<8;i++)store.failed('one:1','offline');assert.equal(store.stats().failed,1);assert.equal(store.retryFailed(),1);assert.equal(store.next().attempts,0);
});
test('SQLite auth preserves credentials, binary keys and atomic deletions',async t=>{
  const{store}=fixture(t);const first=sqliteAuth(store);first.state.creds.registered=true;first.saveCreds();await first.state.keys.set({session:{abc:Buffer.from([0,1,254])}});
  const second=sqliteAuth(store);assert.equal(second.state.creds.registered,true);assert.deepEqual((await second.state.keys.get('session',['abc'])).abc,Buffer.from([0,1,254]));await second.state.keys.set({session:{abc:null}});assert.deepEqual(await second.state.keys.get('session',['abc']),{});
});
test('relay marks delivered only after acknowledgement and saves converted text for retries',async t=>{
  const{store}=fixture(t);store.enqueue('one',1,{text:'original'});let conversions=0,sends=0;
  const whatsapp={ready:true,async send(job,text){sends++;assert.equal(text,'converted');if(sends===1)throw new Error('no acknowledgement');}};
  const relay=new Relay({store,logger,telegram:{ready:true},whatsapp,converter:{async text(){conversions++;return 'converted';}}});
  await relay.drain();clearTimeout(relay.timer);assert.equal(store.stats().sent,0);assert.equal(store.stats().pending,1);
  store.db.prepare('UPDATE posts SET next_at=0').run();await relay.drain();await relay.stop();assert.equal(store.stats().sent,1);assert.equal(conversions,1);assert.equal(sends,2);
});
test('disconnected destinations retain work without increasing retry counters',async t=>{
  const{store}=fixture(t);store.enqueue('one',1,{text:'deal'});const relay=new Relay({store,logger,telegram:{ready:true},whatsapp:{ready:false},converter:{}});await relay.drain();await relay.stop();assert.equal(store.next().attempts,0);
});
test('overlapping worker wake calls do not send duplicate posts',async t=>{
  const{store}=fixture(t);store.enqueue('one',1,{text:'deal'});let sends=0;
  const relay=new Relay({store,logger,telegram:{ready:true},whatsapp:{ready:true,async send(){sends++;await new Promise(resolve=>setTimeout(resolve,10));}},converter:{async text(){return 'deal';}}});
  relay.wake();relay.wake();await relay.task;await relay.stop();assert.equal(sends,1);
});
test('sources are explicit and only channel destinations are accepted',()=>{
  assert.equal(sourceName('@example_deals'),'example_deals');assert.equal(sourceName('https://t.me/example_source'),'example_source');assert.equal(sourceName('-10012345'),'-10012345');assert.throws(()=>sourceName(''),/channel/);
  assert.equal(readConfig({WHATSAPP_TARGET_JID:'123@newsletter',AMAZON_AFFILIATE_TAG:'example-store-21'}).sources.length,0);assert.throws(()=>readConfig({WHATSAPP_TARGET_JID:'123@g.us'}),/newsletter/);
});
test('newsletter acknowledgement resolves only the matching message',async()=>{
  const wa=new WhatsApp({target:'123@newsletter'},null,logger,()=>{});wa.ready=true;
  wa.socket={async sendMessage(jid,content,options){assert.equal(jid,'123@newsletter');assert.equal(content.text,'deal');wa.pendingAcks.get(options.messageId).resolve();}};
  await wa.send({wa_id:'stable-id'},'deal');assert.equal(wa.pendingAcks.size,0);
});

test('an outbox-full recovery error keeps Telegram ready so existing jobs can drain',async()=>{
  let wakes=0;
  const telegram=new Telegram({},null,logger,()=>{wakes++;});
  telegram.ready=true;
  telegram.reconcile=async()=>{throw new Error('Outbox full');};
  await telegram.startRecovery();
  clearInterval(telegram.recoveryTimer);
  assert.equal(telegram.ready,true);assert.equal(wakes,1);assert.match(telegram.error,/Outbox full/);
});

test('public configuration requires the installer to supply its own destination and store',()=>{
  assert.throws(()=>readConfig({}),/WHATSAPP_TARGET_JID/);
  assert.throws(()=>readConfig({WHATSAPP_TARGET_JID:'123@newsletter'}),/AMAZON_AFFILIATE_TAG/);
  const config=readConfig({WHATSAPP_TARGET_JID:'123@newsletter',AMAZON_AFFILIATE_TAG:'example-store-21'});
  assert.equal(config.target,'123@newsletter');assert.equal(config.amazonTag,'example-store-21');
  assert.equal(config.cueId,0);assert.equal(config.host,'127.0.0.1');assert.deepEqual(config.sources,[]);
});
