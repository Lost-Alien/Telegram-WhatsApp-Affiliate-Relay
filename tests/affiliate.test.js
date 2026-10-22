import test from 'node:test';
import assert from 'node:assert/strict';
import { AffiliateConverter, telegramText, publicAddress } from '../src/affiliate.js';
const config = {amazonTag:'our-store-21',amazonDomain:'amazon.in',cueId:123456,subid:'relay',cueKey:'',footer:''};

test('Amazon rewrites the store and strips old tracking, without making an HTTP call', async () => {
  const converter = new AffiliateConverter(config, () => {throw new Error('Unexpected network request');});
  assert.equal(await converter.text('Deal ₹999 https://www.amazon.in/gp/product/B0ABC12345?tag=other-21&ref_=old'), 'Deal ₹999 https://www.amazon.in/dp/B0ABC12345?tag=our-store-21');
});
test('Flipkart keeps product identifiers and replaces affiliate tracking', async () => {
  const output = await new AffiliateConverter(config).convert('https://www.flipkart.com/item/p/itm123?pid=ABC&lid=VARIANT&affid=competitor&affExtParam1=old');
  const wrapped = new URL(output);
  assert.equal(wrapped.searchParams.get('cid'),'123456');
  const product = new URL(wrapped.searchParams.get('url'));
  assert.equal(product.searchParams.get('pid'),'ABC'); assert.equal(product.searchParams.get('lid'),'VARIANT');
  assert.equal(product.searchParams.get('affid'),null); assert.equal(product.searchParams.get('affExtParam1'),null);
});
test('short links are expanded before conversion; unresolved commission links fail for retry', async () => {
  const converter = new AffiliateConverter(config, async () => ({status:302,headers:{location:'https://www.amazon.in/dp/B0ABC12345?tag=old-21'}}));
  assert.equal(await converter.convert('https://amzn.to/abcd'),'https://www.amazon.in/dp/B0ABC12345?tag=our-store-21');
  const unavailable = new AffiliateConverter(config, async () => ({status:403,headers:{}}));
  await assert.rejects(unavailable.convert('https://amzn.to/blocked'),/403/);
});
test('nested affiliate wrappers use our store, and punctuation stays in place', async () => {
  const converter = new AffiliateConverter(config);
  const wrapped='https://linksredirect.com/?cid=other&url='+encodeURIComponent('https://amazon.in/dp/B0ABC12345?tag=old');
  assert.equal(await converter.text(`Buy (${wrapped}).`),'Buy (https://www.amazon.in/dp/B0ABC12345?tag=our-store-21).');
});
test('URL replacement is single-pass even when one URL prefixes another', async () => {
  const output=await new AffiliateConverter(config).text('https://amazon.in/dp/B0ABC12345 https://amazon.in/dp/B0ABC12345?tag=other');
  assert.equal(output.split('https://www.amazon.in/dp/B0ABC12345?tag=our-store-21').length,3);
  assert.ok(!output.includes('?tag=other'));
});
test('other merchant links use our Cuelinks ID, including the API failure fallback', async () => {
  const converter = new AffiliateConverter({...config,cueKey:'test-placeholder'}, async () => { throw new Error('offline'); });
  assert.equal(new URL(await converter.convert('https://myntra.com/product/1')).searchParams.get('cid'),'123456');
});
test('lookalike domains are not treated as Amazon and invitation URLs are removed', async () => {
  const converter = new AffiliateConverter(config);
  assert.equal(await converter.convert('https://amazon.in.example.org/dp/B0ABC12345'),'https://amazon.in.example.org/dp/B0ABC12345');
  assert.equal(await converter.text('Price ₹99\nhttps://t.me/competitor\nCoupon ABC'),'Price ₹99\n\nCoupon ABC');
});
test('hidden Telegram links survive UTF-16 emoji offsets and become affiliate links', async () => {
  const input=telegramText({message:'🔥 Buy now',entities:[{offset:3,length:7,url:'https://amazon.in/dp/B0ABC12345?tag=old'}]});
  assert.equal(await new AffiliateConverter(config).text(input),'🔥 Buy now (https://www.amazon.in/dp/B0ABC12345?tag=our-store-21)');
});
test('URL conversion concurrency stays at two and rejects unbounded input', async () => {
  let active=0, peak=0;
  const converter=new AffiliateConverter(config);
  converter.convert=async raw=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return raw;};
  await converter.text(Array.from({length:12},(_,i)=>`https://example.org/${i}`).join(' '));
  assert.equal(peak,2);
  await assert.rejects(converter.text(Array.from({length:51},(_,i)=>`https://example.org/${i}`).join(' ')),/50/);
});
test('HTTP link destinations exclude private, metadata, mapped and loopback addresses', () => {
  for(const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});

test('Amazon-only setups cannot accidentally use an unrelated Cuelinks channel', async () => {
  const converter = new AffiliateConverter({...config,cueId:0});
  assert.equal(await converter.convert('https://amazon.in/dp/B0ABC12345'),'https://www.amazon.in/dp/B0ABC12345?tag=our-store-21');
  await assert.rejects(converter.convert('https://flipkart.com/item/p/example?pid=EXAMPLE'),/CUELINKS_CHANNEL_ID/);
  await assert.rejects(converter.convert('https://myntra.com/product/example'),/CUELINKS_CHANNEL_ID/);
});
