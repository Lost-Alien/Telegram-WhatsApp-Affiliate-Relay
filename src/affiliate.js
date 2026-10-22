import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';

const matches = (host, domain) => host === domain || host.endsWith('.' + domain);
const amazon = ['amazon.in','amazon.com','amazon.co.uk','amazon.de','amazon.fr','amazon.it','amazon.es','amazon.ca','amazon.com.au','amazon.co.jp','amazon.ae','amazon.sa','amazon.sg'];
const amazonShort = ['amzn.to','amzn.eu','link.amazon','amzaff.to'];
const flipkart = ['flipkart.com','shopsy.in','fkrt.it','fkrt.co','fkrt.in','fkrt.cc','fkrt.to','fkrt.link','fkrt.me','fkr.in','fkr.co','fkr.cc','fkr.to','fkr.it','bilty.co','bilty.in'];
const wrappers = ['linksredirect.com','cuelinks.com','openinapp.co','openinapp.link','earnkaro.com','ern.li','wishlink.com','linkredirect.in','inr.deals','inr.li','bitli.in','hypd.store'];
const merchants = ['reliancedigital.in','r-digital.in','jiomart.com','myntra.com','myntr.it','ajio.com','ajio.co','croma.com','croma.me','vijaysales.com','tatacliq.com','nykaa.com','meesho.com','snapdeal.com','paisabazaar.com','bankbazaar.com','cardinsider.com','sbicard.com','hdfcbank.com','axisbank.com','icicibank.com','kotak.com','idfcfirstbank.com','indusind.com','aubank.in','rblbank.com','yesbank.in','bobcard.co.in','bankofbaroda.in','hsbc.co.in','standardchartered.co.in','bnking.in','v20.in','reliancedigital.app.link','jiomart.app.link'];
const on = (host, domains) => domains.some(domain => matches(host, domain));
const asinOf = url => url.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/o\/|\/product\/|\/ASIN\/|[?&]asin=)([A-Z0-9]{10})(?=[/?&#]|$)/i)?.[1]?.toUpperCase();
const trimUrl = raw => raw.replace(/[.,;:!?\])>*]+$/, '');

export function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  // Only global IPv6 unicast; excludes mapped IPv4 and local/link-local ranges.
  return net.isIP(ip) === 6 && /^[23]/i.test(ip);
}

// Pin the DNS result used by the connection, including every redirect hop.
export async function requestUrl(raw, { method = 'GET', headers = {}, body, timeout = 3500 } = {}) {
  const url = new URL(raw);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Unsupported link destination');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new Error('Link destination is not public');
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers: { 'User-Agent':'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36', ...headers },
      lookup: (_host, options, cb) => options?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family) }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 262144) { res.destroy(); reject(new Error('Link response too large')); } else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Link request timed out')));
    const timer = setTimeout(() => req.destroy(new Error('Link request deadline exceeded')), timeout + 500);
    req.once('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

export class AffiliateConverter {
  constructor(config, request = requestUrl) { this.config = config; this.request = request; }
  wrap(url) {
    if (!this.config.cueId) throw new Error('CUELINKS_CHANNEL_ID is required for merchant affiliate links');
    const out = new URL('https://linksredirect.com/');
    out.search = new URLSearchParams({ cid:String(this.config.cueId), subid1:this.config.subid, source:'api', url }).toString();
    return out.toString();
  }
  async expand(raw) {
    let current = raw;
    const deadline = Date.now() + 6000;
    for (let hop = 0; hop < 5; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Affiliate redirect deadline exceeded');
      const result = await this.request(current, { timeout: Math.min(2000, remaining) });
      if (result.status >= 300 && result.status < 400 && result.headers.location) {
        current = new URL(result.headers.location, current).toString();
      } else if (result.status >= 200 && result.status < 300) return current;
      else throw new Error(`Short link returned HTTP ${result.status}`);
      if (asinOf(current)) return current;
      const host = new URL(current).hostname;
      if (on(host, amazon) || matches(host, 'flipkart.com') || matches(host, 'shopsy.in')) return current;
    }
    throw new Error('Affiliate redirect chain too long');
  }
  async convert(raw, depth = 0) {
    if (depth > 5) throw new Error('Nested affiliate link limit exceeded');
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (on(host, wrappers)) {
      for (const param of ['url','link','target','dest','redirect','u','to']) {
        const value = url.searchParams.get(param);
        if (value && /^https?:\/\//i.test(value)) return this.convert(value, depth + 1);
      }
      // Opaque competitor links must resolve before re-tagging; never forward their commission unchanged.
      const expanded = await this.expand(raw);
      if (expanded === raw) throw new Error('Could not resolve affiliate short link');
      return this.convert(expanded, depth + 1);
    }
    if (on(host, amazonShort)) {
      const direct = matches(host,'link.amazon') && /^\/[A-Z0-9]{10}\/?$/i.test(url.pathname) ? url.pathname.slice(1,11) : null;
      if (direct) return `https://www.${this.config.amazonDomain}/dp/${direct.toUpperCase()}?tag=${encodeURIComponent(this.config.amazonTag)}`;
      const expanded = await this.expand(raw);
      if (expanded === raw) throw new Error('Could not resolve Amazon short link');
      if (!on(new URL(expanded).hostname, amazon)) throw new Error('Amazon short link did not resolve to Amazon');
      return this.convert(expanded, depth + 1);
    }
    if (on(host, amazon)) {
      const asin = asinOf(raw);
      // Use the marketplace and affiliate store supplied by this installation.
      if (asin) return `https://www.${this.config.amazonDomain}/dp/${asin}?tag=${encodeURIComponent(this.config.amazonTag)}`;
      for (const key of [...url.searchParams.keys()]) if (/^(tag|linkCode|ascsubtag|ref_|creative|camp|creativeASIN|utm_.*)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.set('tag', this.config.amazonTag);
      return url.toString();
    }
    if (on(host, flipkart)) {
      const canonical = matches(host,'flipkart.com') || matches(host,'shopsy.in');
      const expanded = canonical ? raw : await this.expand(raw);
      const clean = new URL(expanded);
      if (!matches(clean.hostname,'flipkart.com') && !matches(clean.hostname,'shopsy.in')) throw new Error('Flipkart short link did not resolve to a product');
      // pid and lid identify the product/variant and must remain intact.
      for (const key of [...clean.searchParams.keys()]) if (/^(affid|affExtParam.*|otracker.*|utm_.*|ssid|vsugd)$/i.test(key)) clean.searchParams.delete(key);
      return this.wrap(clean.toString());
    }
    if (on(host, merchants)) {
      if (!this.config.cueId) throw new Error('CUELINKS_CHANNEL_ID is required for merchant affiliate links');
      if (!this.config.cueKey) return this.wrap(raw);
      try {
        const result = await this.request('https://developers.cuelinks.com/pub_api/v3/links/convert.json', {
          method:'POST', timeout:3000, headers:{ Authorization:`Token ${this.config.cueKey}`, 'Content-Type':'application/json' },
          body:JSON.stringify({url:raw,channel_id:this.config.cueId,shorten:true,subid1:this.config.subid})
        });
        const data = JSON.parse(result.body).data;
        const output = data?.short_url || data?.shorten_url || data?.affiliate_url || data?.tracking_url;
        if (result.status === 200 && output && /^https?:\/\//i.test(output)) return output;
      } catch { /* The direct tracking redirect works without a shortener request. */ }
      return this.wrap(raw);
    }
    return raw;
  }
  async text(input) {
    // Strip competing channel invitation URLs; preserve deal text, prices, coupons and formatting.
    const text = input.replace(/https?:\/\/(?:www\.)?(?:whatsapp\.com\/channel|chat\.whatsapp\.com|t\.me|telegram\.me)\/[^\s]+/gi, '').trim();
    const urls = [...new Set(text.match(/https?:\/\/[^\s<>]+/g) || [])];
    if (urls.length > 50) throw new Error('Post exceeds 50 unique URLs');
    const converted = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < urls.length) {
        const raw = urls[cursor++], clean = trimUrl(raw);
        converted.set(raw, await this.convert(clean) + raw.slice(clean.length));
      }
    };
    await Promise.all([worker(), worker()]);
    let output = text.replace(/https?:\/\/[^\s<>]+/g, raw => converted.get(raw) || raw);
    if (output && this.config.footer) output += '\n\n' + this.config.footer;
    return output;
  }
}

export function telegramText(message) {
  let text = message.message || '';
  // Telegram entity offsets and JS string indexes both count UTF-16 code units.
  for (const entity of [...(message.entities || [])].sort((a,b) => b.offset - a.offset)) {
    if (entity.url && /^https?:\/\//i.test(entity.url)) {
      const end = entity.offset + entity.length;
      text = text.slice(0, end) + ` (${entity.url})` + text.slice(end);
    }
  }
  return text;
}
