import { defaultBaseURL, type ProviderProfile } from '../core/config.js';
import { RoastError } from '../core/errors.js';

/** Both Anthropic host roots and /v1 bases are accepted by custom gateways. */
export function providerEndpoint(profile: ProviderProfile, endpoint: string): string {
  const base = (profile.baseURL ?? defaultBaseURL(profile.driver)).trim().replace(/\/+$/, '');
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RoastError('CONFIG', '供应商地址须为无内嵌凭据、查询参数和锚点的 HTTP(S) URL');
  }
  const prefix = profile.driver === 'anthropic' && !url.pathname.endsWith('/v1') ? 'v1/' : '';
  return `${base}/${prefix}${endpoint}`;
}
