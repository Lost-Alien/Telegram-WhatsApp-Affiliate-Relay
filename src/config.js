import path from 'node:path';

export function readConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const target = (env.WHATSAPP_TARGET_JID || '').trim();
  if (!/^\d+@newsletter$/.test(target)) throw new Error('WHATSAPP_TARGET_JID must be your channel newsletter JID');
  const amazonTag = (env.AMAZON_AFFILIATE_TAG || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(amazonTag)) throw new Error('AMAZON_AFFILIATE_TAG must be your own Amazon Associates store tag');
  const sources = (env.TELEGRAM_SOURCE_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const domain = env.AMAZON_DOMAIN || 'amazon.in';
  if (!/^amazon\.(in|com|co\.uk|de|fr|it|es|ca|com\.au|co\.jp|com\.br|com\.mx|ae|sa|sg)$/.test(domain)) throw new Error('Unsupported AMAZON_DOMAIN');
  return {
    apiId: number('TELEGRAM_API_ID', 0, 0, 2147483647), apiHash: env.TELEGRAM_API_HASH || '',
    sources, target, amazonTag, amazonDomain: domain,
    cueId: number('CUELINKS_CHANNEL_ID', 0, 0, 2147483647), cueKey: env.CUELINKS_API_KEY || '',
    subid: env.CUELINKS_SUBID || 'tgwarelay', footer: env.FOOTER_URL || '',
    host: env.HOST || '127.0.0.1', port: number('PORT', 3100, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || '.data'), maxMediaBytes: number('MAX_MEDIA_MIB', 8, 1, 16) * 1048576,
    maxQueued: number('MAX_QUEUED_POSTS', 1000, 1, 10000), logLevel: env.LOG_LEVEL || 'info'
  };
}
