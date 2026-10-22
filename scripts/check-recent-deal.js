// Run with the relay service stopped; uses only this relay's own account session and database.
import 'dotenv/config';
import path from 'node:path';
import { TelegramClient, Logger, utils } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AffiliateConverter } from '../src/affiliate.js';
import { sourceName, snapshot } from '../src/telegram.js';

const config=readConfig();
const store=new Store(path.join(config.dataDir,'relay.sqlite'),config.maxQueued);
const client=new TelegramClient(new StringSession(store.get('telegramSession','')),config.apiId,config.apiHash,{connectionRetries:3,baseLogger:new Logger('error')});
let exitCode=0;
try{
  await client.connect();
  if(!await client.checkAuthorization())throw new Error('Relay Telegram account is not connected');
  const candidates=[];
  const sourceStatus=[];
  for(const source of config.sources){
    const entity=await client.getEntity(sourceName(source));
    const messages=await client.getMessages(entity,{limit:10});
    sourceStatus.push({source,latestMessage:messages[0]?.id,latestUtc:messages[0]?.date?new Date(messages[0].date*1000).toISOString():null});
    for(const message of messages){
      const payload=snapshot(message);
      if(!message.noforwards && !message.media?.ttlSeconds && message.date*1000>Date.now()-3600000 &&
        /https?:\/\/(?:www\.)?(?:amzn\.|amazon\.|fkrt\.|flipkart\.|link\.amazon|myntr\.it|myntra\.)/i.test(payload.text) &&
        !/over now|expired|out of stock|sold out/i.test(payload.text) && (!payload.media || payload.media.size<=config.maxMediaBytes)){
        candidates.push({source,chat:utils.getPeerId(entity).toString(),message,payload});
      }
    }
  }
  candidates.sort((a,b)=>b.message.date-a.message.date);
  console.log(JSON.stringify({sources:sourceStatus}));
  if(!candidates.length)console.log(JSON.stringify({check:'No eligible deal in the last hour; no test post sent'}));
  else{
    const candidate=candidates[0];
    const converted=await new AffiliateConverter(config).text(candidate.payload.text);
    const added=store.enqueue(candidate.chat,candidate.message.id,candidate.payload);
    if(added)store.converted(`${candidate.chat}:${candidate.message.id}`,converted);
    console.log(JSON.stringify({check:added?'Recent source deal queued for delivery':'Deal already in outbox',source:candidate.source,message:candidate.message.id,media:candidate.payload.media?.kind||null,affiliateConverted:converted!==candidate.payload.text}));
  }
}catch(error){console.error(error.message);exitCode=1;}
finally{await client.disconnect();store.close();process.exit(exitCode);}
