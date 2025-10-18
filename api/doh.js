const DEFAULT_UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_ECS_UPSTREAM = 'https://dns.google/dns-query';
const DEFAULT_JSON_UPSTREAM = 'https://dns.google/resolve';

const AUTO_ADD_ECS_ENABLED = (process.env.AUTO_ADD_ECS || 'false').toLowerCase() === 'true';
const IPV4_ECS_PREFIX_LENGTH = parseInt(process.env.IPV4_ECS_PREFIX_LENGTH, 10) || 24;
const IPV6_ECS_PREFIX_LENGTH = parseInt(process.env.IPV6_ECS_PREFIX_LENGTH, 10) || 56;
const DEBUG_LOGGING = (process.env.DEBUG_LOGGING || 'false').toLowerCase() === 'true';
const FORCE_RESPONSE_PADDING = (process.env.FORCE_RESPONSE_PADDING || 'false').toLowerCase() === 'true';

const ALLOWED_METHODS = ['GET', 'POST'];
const CONTENT_TYPE_DNS_MESSAGE = 'application/dns-message';
const CONTENT_TYPE_DNS_JSON = 'application/dns-json';
const ACCEPT_HEADER_REGEX = /application\/(dns-message|dns-json)/;
const PADDING_BLOCK_SIZE = 128;
const EDNS_OPTION_CODE_ECS = 8;
const EDNS_RR_TYPE_OPT = 41;
const IPV4_FAMILY = 1;
const IPV6_FAMILY = 2;
const CACHE_CONTROL_CDN_ENABLED_HEADER_VALUE = 's-maxage=600, stale-while-revalidate=600';
const CACHE_CONTROL_CDN_DISABLED_HEADER_VALUE = 'private, no-store, max-age=0';

const parseCsvUrls = (envVar, defaultValue) => {
    const urls = (envVar || '').split(',').map(url => url.trim()).filter(url => url.length > 0);
    return urls.length > 0 ? urls : [defaultValue];
};

const regularUpstreamUrls = parseCsvUrls(process.env.UPSTREAM_DOH_URLS, DEFAULT_UPSTREAM);
const ecsUpstreamUrls = parseCsvUrls(process.env.ECS_UPSTREAM_DOH_URLS, DEFAULT_ECS_UPSTREAM);
const jsonUpstreamUrls = parseCsvUrls(process.env.JSON_UPSTREAM_DOH_URLS, DEFAULT_JSON_UPSTREAM);

const logger = {
    log: (...args) => { if (DEBUG_LOGGING) console.log('[DOH]', ...args); },
    warn: (...args) => { if (DEBUG_LOGGING) console.warn('[DOH]', ...args); },
    error: (...args) => { console.error('[DOH]', ...args); },
};

logger.log(`配置: 常规上游 (dns-message)=${regularUpstreamUrls.join(', ')}`);
logger.log(`配置: ECS 上游 (dns-message)=${ecsUpstreamUrls.join(', ')}`);
logger.log(`配置: JSON 上游 (dns-json)=${jsonUpstreamUrls.join(', ')}`);
logger.log(`配置: 强制响应填充=${FORCE_RESPONSE_PADDING}`);
logger.log(`配置: 自动附加ECS (全局)=${AUTO_ADD_ECS_ENABLED}`);
if (AUTO_ADD_ECS_ENABLED) {
    logger.log(`配置: ECS IPv4 前缀长度=${IPV4_ECS_PREFIX_LENGTH}`);
    logger.log(`配置: ECS IPv6 前缀长度=${IPV6_ECS_PREFIX_LENGTH}`);
}

export const config = { runtime: 'edge' };

function parseIpAddress(ipString) {
    if (!ipString) return null;
    if (ipString.includes('.')) {
        const parts = ipString.split('.').map(part => parseInt(part, 10));
        if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
            return { family: IPV4_FAMILY, addressBytes: new Uint8Array(parts) };
        }
    } else if (ipString.includes(':')) {
        const parts = ipString.split('::');
        if (parts.length > 2) return null;
        let part1 = [], part2 = [];
        part1 = parts[0].split(':').filter(p => p.length > 0);
        if (parts.length === 2) {
            part2 = parts[1].split(':').filter(p => p.length > 0);
        }
        const totalParts = part1.length + part2.length;
        if (totalParts > 8) return null;
        const hexParts = [...part1, ...Array(8 - totalParts).fill('0'), ...part2];
        if (hexParts.length !== 8) return null;
        const addressBytes = new Uint8Array(16);
        for (let i = 0; i < 8; i++) {
            const hex = parseInt(hexParts[i], 16);
            if (isNaN(hex) || hex > 0xFFFF) return null;
            addressBytes[i * 2] = hex >> 8;
            addressBytes[i * 2 + 1] = hex & 0xFF;
        }
        return { family: IPV6_FAMILY, addressBytes };
    }
    return null;
}

function createEcsOptionBytes(ipInfo) { const { family, addressBytes } = ipInfo; const sourcePrefixLength = family === IPV4_FAMILY ? IPV4_ECS_PREFIX_LENGTH : IPV6_ECS_PREFIX_LENGTH; const scopePrefixLength = 0; const addressByteLength = Math.ceil(sourcePrefixLength / 8); const truncatedAddress = addressBytes.slice(0, addressByteLength); const optionLength = 2 + 1 + 1 + truncatedAddress.length; const ecsData = new Uint8Array(4 + optionLength); const view = new DataView(ecsData.buffer); view.setUint16(0, EDNS_OPTION_CODE_ECS, false); view.setUint16(2, optionLength, false); view.setUint16(4, family, false); view.setUint8(6, sourcePrefixLength); view.setUint8(7, scopePrefixLength); ecsData.set(truncatedAddress, 8); return ecsData; }
function encodeBase64Url(buffer) { const bytes = new Uint8Array(buffer); let binary = ''; for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); } return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function applyHttpResponsePadding(originalBuffer) { const originalLength = originalBuffer.byteLength; if (originalLength === 0) return originalBuffer; const paddingLength = (PADDING_BLOCK_SIZE - (originalLength % PADDING_BLOCK_SIZE)) % PADDING_BLOCK_SIZE; if (paddingLength === 0) return originalBuffer; const paddedBuffer = new Uint8Array(originalLength + paddingLength); paddedBuffer.set(new Uint8Array(originalBuffer), 0); logger.log(`应用 HTTP 响应填充: 原始=${originalLength}, 填充=${paddingLength}, 总=${paddedBuffer.byteLength}`); return paddedBuffer.buffer; }
function decodeBase64Url(base64url) { try { const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/'); const padLength = (4 - (base64.length % 4)) % 4; const paddedBase64 = base64 + '='.repeat(padLength); const binaryString = atob(paddedBase64); const len = binaryString.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); } return bytes.buffer; } catch (e) { logger.error('Base64URL 解码失败:', e); return null; } }
async function fetchAndValidate(url, options) { logger.log(`发起请求到: ${url}`); const response = await fetch(url, options); logger.log(`收到来自 ${url} 的响应: 状态=${response.status}`); if (!response.ok) { throw new Error(`上游错误 ${response.status} from ${url}`); } response.originatingUrl = url; return response; }
function skipDnsName(view, offset) { while (offset < view.byteLength) { const len = view.getUint8(offset); if (len === 0) { return offset + 1; } else if ((len & 0xc0) === 0xc0) { return offset + 2; } else { offset += len + 1; } } return offset; }
function containsMeaningfulECSOption(dnsMessageBuffer) { if (!dnsMessageBuffer || dnsMessageBuffer.byteLength < 12) return false; const view = new DataView(dnsMessageBuffer); try { const qdCount = view.getUint16(4, false); const anCount = view.getUint16(6, false); const nsCount = view.getUint16(8, false); const arCount = view.getUint16(10, false); if (arCount === 0) return false; let offset = 12; for (let i = 0; i < qdCount; i++) { offset = skipDnsName(view, offset); offset += 4; if (offset > view.byteLength) return false; } for (let i = 0; i < anCount + nsCount; i++) { offset = skipDnsName(view, offset); offset += 8; if (offset + 2 > view.byteLength) return false; const rdLength = view.getUint16(offset, false); offset += 2 + rdLength; if (offset > view.byteLength) return false; } for (let i = 0; i < arCount; i++) { offset = skipDnsName(view, offset); if (offset + 10 > view.byteLength) return false; const rrType = view.getUint16(offset, false); if (rrType === EDNS_RR_TYPE_OPT) { offset += 8; const rdLength = view.getUint16(offset, false); offset += 2; const endOffset = offset + rdLength; while (offset + 4 <= endOffset) { const optCode = view.getUint16(offset, false); const optLen = view.getUint16(offset + 2, false); if (optCode === EDNS_OPTION_CODE_ECS && optLen >= 4) { const family = view.getUint16(offset + 4, false); const sourcePrefix = view.getUint8(offset + 6); if (sourcePrefix > 0 && (family === IPV4_FAMILY || family === IPV6_FAMILY)) { return true; } } offset += 4 + optLen; } return false; } offset += 8; const rdLength = view.getUint16(offset, false); offset += 2 + rdLength; if (offset > view.byteLength) return false; } } catch (e) { logger.error("DNS 解析出错:", e); } return false; }
function addOptRrWithEcs(originalDnsBuffer, ecsOptionBytes) { const originalView = new DataView(originalDnsBuffer); const optRrTotalLength = 11 + ecsOptionBytes.length; const newBufferLength = originalDnsBuffer.byteLength + optRrTotalLength; const newBuffer = new ArrayBuffer(newBufferLength); const newUint8Array = new Uint8Array(newBuffer); const newView = new DataView(newBuffer); newUint8Array.set(new Uint8Array(originalDnsBuffer)); let offset = originalDnsBuffer.byteLength; newView.setUint8(offset, 0); offset += 1; newView.setUint16(offset, EDNS_RR_TYPE_OPT, false); offset += 2; newView.setUint16(offset, 4096, false); offset += 2; newView.setUint32(offset, 0, false); offset += 4; newView.setUint16(offset, ecsOptionBytes.length, false); offset += 2; newUint8Array.set(ecsOptionBytes, offset); const arCount = originalView.getUint16(10, false); newView.setUint16(10, arCount + 1, false); logger.log(`成功将 OPT RR 附加到 DNS 报文。原 ARCOUNT: ${arCount}, 新 ARCOUNT: ${arCount + 1}`); return newBuffer; }

export default async function handler(request) {
    try {
        const { method, headers, url } = request;
        const requestUrl = new URL(url);
        const { pathname, searchParams: queryParams } = requestUrl;

        if (!ALLOWED_METHODS.includes(method)) return new Response('方法不允许', { status: 405 });
        const clientAcceptHeader = headers.get('accept');
        if (!clientAcceptHeader || !ACCEPT_HEADER_REGEX.test(clientAcceptHeader)) return new Response('不接受的类型...', { status: 406 });

        let ecsBehavior = 'default';
        if (pathname.endsWith('/no_ecs')) {
            ecsBehavior = 'force_disable';
            logger.log('路径 /no_ecs 检测到: 本次请求强制禁用ECS。');
        } else if (pathname.endsWith('/auto_ecs')) {
            ecsBehavior = 'force_enable';
            logger.log('路径 /auto_ecs 检测到: 本次请求强制启用自动附加ECS。');
        }
      
        let dnsMessageBuffer = null;
        let isDnsMessageFormatExpected = false;
        let isJsonFormatExpected = false;
    
        if (method === 'GET') {
            if (queryParams.has('dns')) {
                dnsMessageBuffer = decodeBase64Url(queryParams.get('dns'));
                if (!dnsMessageBuffer) return new Response('请求参数错误: 无效的 dns 参数编码', { status: 400 });
                isDnsMessageFormatExpected = true;
            } else if (queryParams.get('ct') === CONTENT_TYPE_DNS_JSON || clientAcceptHeader.includes(CONTENT_TYPE_DNS_JSON)) {
                isJsonFormatExpected = true;
            } else { return new Response('请求参数错误', { status: 400 }); }
        } else if (method === 'POST') {
            if (headers.get('content-type') !== CONTENT_TYPE_DNS_MESSAGE) return new Response('不支持的请求体类型', { status: 415 });
            dnsMessageBuffer = await request.arrayBuffer();
            if (!dnsMessageBuffer || dnsMessageBuffer.byteLength === 0) return new Response('请求体不能为空', { status: 400 });
            isDnsMessageFormatExpected = true;
        }

        let ecsAddedByProxy = false;
        let requestHadEcsInitially = false;

        if (isDnsMessageFormatExpected && dnsMessageBuffer) {
            requestHadEcsInitially = containsMeaningfulECSOption(dnsMessageBuffer);

            const shouldAddEcs = !requestHadEcsInitially && 
                                 (ecsBehavior === 'force_enable' || (ecsBehavior === 'default' && AUTO_ADD_ECS_ENABLED));

            if (shouldAddEcs) {
                const clientIp = headers.get('cf-connecting-ip') || headers.get('x-forwarded-for')?.split(',')[0].trim() || null;
                const ipSource = headers.get('cf-connecting-ip') ? 'cf-connecting-ip' : 'x-forwarded-for';
            
                if (clientIp) {
                    const ipInfo = parseIpAddress(clientIp);
                    if (ipInfo) {
                        logger.log(`自动附加ECS: 从 ${ipSource} 获取到IP (${clientIp})，解析为 family ${ipInfo.family}。`);
                        dnsMessageBuffer = addOptRrWithEcs(dnsMessageBuffer, createEcsOptionBytes(ipInfo));
                        ecsAddedByProxy = true;
                    } else { logger.warn(`自动附加ECS: 无法解析来自 ${ipSource} 的客户端 IP 地址: ${clientIp}`); }
                } else { logger.log('自动附加ECS: 无法从 cf-connecting-ip 或 x-forwarded-for 头部获取客户端 IP。'); }
            }
        }

        const finalRequestHasEcs = requestHadEcsInitially || ecsAddedByProxy;

        let selectedUpstreamList;
        if (isJsonFormatExpected) {
            selectedUpstreamList = jsonUpstreamUrls;
        } else if (isDnsMessageFormatExpected) {
            selectedUpstreamList = finalRequestHasEcs ? ecsUpstreamUrls : regularUpstreamUrls;
            logger.log(`上游决策: 最终请求 ${finalRequestHasEcs ? '包含' : '不包含'} ECS，选择 ${finalRequestHasEcs ? 'ECS' : '常规'} 上游。`);
        } else { return new Response('无法确定请求类型', { status: 400 }); }
        if (!selectedUpstreamList || selectedUpstreamList.length === 0) return new Response('服务配置错误: 无可用的上游服务器', { status: 500 });
    
        let fetchOptions = { method: method, headers: new Headers({ 'Accept': clientAcceptHeader }), redirect: 'follow' };
        if (method === 'POST' && dnsMessageBuffer) {
            fetchOptions.body = dnsMessageBuffer;
            fetchOptions.headers.set('Content-Type', CONTENT_TYPE_DNS_MESSAGE);
        }

        const fetchPromises = selectedUpstreamList.map(baseUrl => {
            let targetUrl = new URL(baseUrl);
            if (method === 'GET') {
                if (isDnsMessageFormatExpected) {
                    targetUrl.search = `?dns=${encodeBase64Url(dnsMessageBuffer)}`;
                } else {
                    const upstreamParams = new URLSearchParams();
                    if (queryParams.has('name')) upstreamParams.set('name', queryParams.get('name'));
                    if (queryParams.has('type')) upstreamParams.set('type', queryParams.get('type'));
                    if (queryParams.has('cd')) upstreamParams.set('cd', queryParams.get('cd'));
                    if (queryParams.has('do')) upstreamParams.set('do', queryParams.get('do'));
                    targetUrl.search = upstreamParams.toString();
                }
            }
            return fetchAndValidate(targetUrl.toString(), fetchOptions);
        });
      
        const winningUpstreamResponse = await Promise.any(fetchPromises)
            .catch(error => {
                if (error instanceof AggregateError) {
                    logger.error('所有上游服务器均请求失败:', error.errors.map(e => e.message));
                }
                return null;
            });

        if (!winningUpstreamResponse) return new Response('服务暂时不可用 (所有上游均失败)', { status: 502 });

        const upstreamBody = await winningUpstreamResponse.arrayBuffer();
        const responseHeaders = new Headers(winningUpstreamResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Accept');

        if (method === 'GET') {
            if (isJsonFormatExpected) {
                logger.log(`缓存决策: JSON API 请求，应用 CDN 缓存策略。`);
                responseHeaders.set('Cache-Control', CACHE_CONTROL_CDN_ENABLED_HEADER_VALUE);
            } else if (isDnsMessageFormatExpected) {
                if (ecsAddedByProxy) {
                    logger.log(`缓存决策: dns-message GET 请求且代理已附加 ECS，禁止 CDN 缓存。`);
                    responseHeaders.set('Cache-Control', CACHE_CONTROL_CDN_DISABLED_HEADER_VALUE);
                } else {
                    logger.log(`缓存决策: dns-message GET 请求且代理未附加 ECS，应用 CDN 缓存策略。`);
                    responseHeaders.set('Cache-Control', CACHE_CONTROL_CDN_ENABLED_HEADER_VALUE);
                }
            }
        } else { responseHeaders.delete('Cache-Control'); }

        let finalBody = upstreamBody;
        if (isDnsMessageFormatExpected && FORCE_RESPONSE_PADDING) {
            finalBody = applyHttpResponsePadding(upstreamBody);
        }
        responseHeaders.set('Content-Length', finalBody.byteLength.toString());

        return new Response(finalBody, { status: winningUpstreamResponse.status, headers: responseHeaders });
    } catch (error) {
        logger.error('处理请求时发生内部错误:', error.stack || error);
        return new Response('服务内部错误', { status: 500 });
    }
}

