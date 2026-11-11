/**
 * 参考素材上传引擎
 *
 * 本地文件 → 平台上传票 → 云存储 → obj_name 引用（填入 generate_image /
 * generate_video 的 reference_images / reference_videos / reference_audios）。
 *
 * 三条路：
 * - 图片：ImageX STS 直传（字节不过平台 API）——Apply/Commit 走
 *   imagex.volcengineapi.com（V4 签名），PUT 直连上传节点（Content-CRC32 必带，
 *   Authorization 用 Apply 预签的 Auth）；STS 被平台锁定到本票 obj_name，
 *   传其他 StoreKey 网关直接 400。完成后 POST complete 复核领 obj_name。
 * - 视频：VOD STS 直传——Apply/Commit 走 vod.volcengineapi.com（V4 签名，GET），
 *   上传直连 TOS 节点，≤20MB 单 PUT / >20MB 分片，Commit 返回 Vid 交平台复核。
 * - 音频：multipart POST /data 平台中转落 S3（ffprobe 复核时长）。
 *
 * 云 API 一律走 node:https 原生栈；平台 REST 用 fetch。
 * 限制：图片/视频/音频 ≤50MB、视频 ≤30s、音频 ≤60s（mp3/wav）。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'

const VOD_HOST = 'vod.volcengineapi.com'
const IMAGEX_HOST = 'imagex.volcengineapi.com'
const REGION = 'cn-north-1'
const MAX_BYTES = 50 * 1024 * 1024
const CHUNK_SIZE = 20 * 1024 * 1024 // SDK MinChunkSize：超过走分片

const EXT_KIND = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
  '.mp3': 'audio', '.wav': 'audio',
}
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

export class UploadError extends Error {}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const hmacBuf = (key, msg) => createHmac('sha256', key).update(msg).digest()
const sha256hex = msg => createHash('sha256').update(msg).digest('hex')
const uriEncode = s => encodeURIComponent(String(s))
const crc32hex = buf => (zlib.crc32(buf) >>> 0).toString(16).padStart(8, '0')

// ---------------------------------------------------------------------------
// node:https 原生请求（云 API 专用；自动解压 gzip/deflate/br）
// ---------------------------------------------------------------------------

function nativeRequest(urlStr, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const h = { ...headers }
    if (body !== undefined) h['content-length'] = String(body.length)
    const req = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers: h },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          let buf = Buffer.concat(chunks)
          const ce = String(res.headers['content-encoding'] ?? '')
          try {
            if (ce.includes('gzip')) buf = zlib.gunzipSync(buf)
            else if (ce.includes('deflate')) buf = zlib.inflateSync(buf)
            else if (ce.includes('br')) buf = zlib.brotliDecompressSync(buf)
          } catch { /* 解压失败按原文处理 */ }
          resolve({ status: res.statusCode, text: buf.toString() })
        })
      })
    req.on('error', reject)
    if (body !== undefined && body.length) req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// 火山 V4 签名（volcengine 变体）
// ---------------------------------------------------------------------------

function volcSignHeaders(sts, { method, host, path, query, body, service }) {
  const bodyStr = body ?? ''
  const bodyHash = sha256hex(bodyStr)
  const long = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const short = long.slice(0, 8)
  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&')
  const headers = {
    'content-type': 'application/json',
    host,
    'x-content-sha256': bodyHash,
    'x-date': long,
  }
  if (sts.sessionToken) headers['x-security-token'] = sts.sessionToken
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map(n => `${n}:${headers[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const scope = `${short}/${REGION}/${service}/request`
  const stringToSign = ['HMAC-SHA256', long, scope, sha256hex(canonicalRequest)].join('\n')
  let k = hmacBuf(sts.secretAccessKey, short)
  k = hmacBuf(k, REGION)
  k = hmacBuf(k, service)
  k = hmacBuf(k, 'request')
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex')
  return {
    accept: 'application/json',
    'user-agent': 'dsh-solmirror/0.14.8',
    'content-type': 'application/json',
    'x-content-sha256': bodyHash,
    'x-date': long,
    ...(sts.sessionToken ? { 'x-security-token': sts.sessionToken } : {}),
    authorization:
      `HMAC-SHA256 Credential=${sts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** 调火山 VOD OpenAPI（Apply/Commit 均 GET + query）。 */
async function vodApi(sts, { action, params }) {
  const query = { Action: action, Version: '2022-01-01', ...params }
  const headers = volcSignHeaders(sts, { method: 'GET', host: VOD_HOST, path: '/', query, body: '', service: 'vod' })
  const url = `https://${VOD_HOST}/?${Object.keys(query).map(k => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&')}`
  let resp
  try {
    resp = await nativeRequest(url, { method: 'GET', headers, body: undefined })
  } catch (error) {
    throw new UploadError(`火山 ${action} 网络失败：${String(error?.message ?? error)}`)
  }
  let data = null
  try { data = JSON.parse(resp.text) } catch {
    throw new UploadError(`火山 ${action} 网关异常：HTTP ${resp.status} ${resp.text.slice(0, 150)}`)
  }
  const err = data?.ResponseMetadata?.Error
  if (err) throw new UploadError(`火山 ${action} 失败：${err.CodeN ?? err.Code ?? ''} ${err.Message ?? ''}`)
  return data?.Result?.Data ?? data?.Result ?? {}
}

/** 调火山 ImageX OpenAPI（Apply=GET；Commit=POST + JSON body）。 */
async function imagexApi(sts, { action, method = 'GET', params = {}, body }) {
  const query = { Action: action, Version: '2018-08-01', ...params }
  const headers = volcSignHeaders(sts, {
    method, host: IMAGEX_HOST, path: '/', query, body: body ?? '', service: 'imagex',
  })
  const url = `https://${IMAGEX_HOST}/?${Object.keys(query).map(k => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&')}`
  let resp
  try {
    resp = await nativeRequest(url, { method, headers, body: body !== undefined ? Buffer.from(body) : undefined })
  } catch (error) {
    throw new UploadError(`火山 ${action} 网络失败：${String(error?.message ?? error)}`)
  }
  let data = null
  try { data = JSON.parse(resp.text) } catch {
    throw new UploadError(`火山 ${action} 网关异常：HTTP ${resp.status} ${resp.text.slice(0, 150)}`)
  }
  const err = data?.ResponseMetadata?.Error
  if (err) throw new UploadError(`火山 ${action} 失败：${err.CodeN ?? err.Code ?? ''} ${err.Message ?? ''}`)
  return data?.Result ?? {}
}

// ---------------------------------------------------------------------------
// TOS 上传节点（PUT；Authorization=Apply 预签的 Auth；Content-CRC32 必带）
// ---------------------------------------------------------------------------

async function tosPut(url, headers, body) {
  let resp
  try {
    resp = await nativeRequest(url, { method: 'PUT', headers, body: body ?? undefined })
  } catch (error) {
    throw new UploadError(`上传节点网络失败：${String(error?.message ?? error)}`)
  }
  let json = null
  try { json = JSON.parse(resp.text) } catch { /* 直传/分片的成功响应也是 JSON */ }
  if (resp.status !== 200 || !json || json.success !== 0) {
    throw new UploadError(`上传节点失败：HTTP ${resp.status} ${resp.text.slice(0, 150)}`)
  }
  return json
}

/**
 * 视频直传 VOD：Apply → TOS（≤20MB 单 PUT / >20MB 分片，gateway 模式 partNumber
 * 从 1 起）→ Commit（返回 Vid）。
 */
async function uploadVod(sts, spaceName, fileName, ext, bytes) {
  const applyRoot = await vodApi(sts, {
    action: 'ApplyUploadInfo',
    params: { SpaceName: spaceName, FileSize: bytes.length, FileName: fileName, FileExtension: ext, NeedFallback: 'True' },
  })
  const addr = applyRoot.UploadAddress ?? applyRoot.CandidateUploadAddresses?.MainUploadAddresses?.[0]
  const info = addr?.StoreInfos?.[0]
  const host = addr?.UploadHosts?.[0]
  if (!info?.StoreUri || !info?.Auth || !host || !addr?.SessionKey) {
    throw new UploadError('VOD 上传地址不完整（StoreUri/Auth/UploadHost/SessionKey 缺失）')
  }
  const base = `https://${host}/${info.StoreUri}`
  const authHeaders = { Authorization: info.Auth }

  if (bytes.length < CHUNK_SIZE) {
    await tosPut(base, { ...authHeaders, 'Content-CRC32': crc32hex(bytes) }, bytes)
  } else {
    const init = await tosPut(`${base}?uploads`, authHeaders, undefined)
    const uploadId = init?.payload?.uploadID
    if (!uploadId) throw new UploadError('分片初始化返回缺少 uploadID')
    const parts = []
    const count = Math.ceil(bytes.length / CHUNK_SIZE)
    for (let i = 0; i < count; i++) {
      const chunk = bytes.subarray(i * CHUNK_SIZE, Math.min(bytes.length, (i + 1) * CHUNK_SIZE))
      const sum = crc32hex(chunk)
      // gateway 大文件模式 partNumber 从 1 起
      const payload = await tosPut(
        `${base}?partNumber=${i + 1}&uploadID=${uriEncode(uploadId)}`,
        { ...authHeaders, 'Content-CRC32': sum }, chunk)
      parts.push({ sum, payload })
    }
    // merge body："序号:crc32" 逗号拼接；带首片返回的 ObjectContentType
    const body = parts.map((p, i) => `${i + 1}:${p.sum}`).join(',')
    let url = `${base}?uploadID=${uriEncode(uploadId)}`
    const meta = parts[0]?.payload?.payload?.meta ?? parts[0]?.payload?.meta
    const oct = meta?.ObjectContentType ?? ''
    if (oct) url += `&ObjectContentType=${uriEncode(oct)}`
    await tosPut(url, authHeaders, Buffer.from(body))
  }

  const commit = await vodApi(sts, {
    action: 'CommitUploadInfo',
    params: { SpaceName: spaceName, SessionKey: addr.SessionKey },
  })
  const vid = commit?.Vid ?? commit?.Data?.Vid
  if (!vid) throw new UploadError(`VOD Commit 未返回 Vid：${JSON.stringify(commit).slice(0, 150)}`)
  return String(vid)
}

/**
 * 图片直传 ImageX：Apply → PUT（Content-CRC32 必带）→ Commit。平台签发的 STS
 * 已把 StoreKeys 资源限定到本票 obj_name，传其他 StoreKey 会被网关 400 拒
 * （InvalidParameter.StorageFileName，2026-11-10 实测）。
 */
async function uploadImagex(sts, serviceId, storeKey, bytes) {
  const apply = await imagexApi(sts, {
    action: 'ApplyImageUpload',
    params: { ServiceId: serviceId, UploadNum: '1', StoreKeys: storeKey, Overwrite: 'False' },
  })
  const addr = apply?.UploadAddress
  const info = addr?.StoreInfos?.[0]
  const host = addr?.UploadHosts?.[0]
  if (!info?.StoreUri || !info?.Auth || !host || !addr?.SessionKey) {
    throw new UploadError('ImageX 上传地址不完整（StoreUri/Auth/UploadHost/SessionKey 缺失）')
  }
  await tosPut(`https://${host}/${info.StoreUri}`,
    { Authorization: info.Auth, 'Content-CRC32': crc32hex(bytes) }, bytes)
  const commit = await imagexApi(sts, {
    action: 'CommitImageUpload', method: 'POST',
    params: { ServiceId: serviceId, SkipMeta: 'False' },
    body: JSON.stringify({
      SessionKey: addr.SessionKey, SuccessOids: [info.StoreUri], Functions: [], OptionInfos: [],
    }),
  })
  const r0 = commit?.Results?.[0]
  if (!r0 || r0.UriStatus !== 2000) {
    throw new UploadError(`ImageX Commit 未确认成功：${JSON.stringify(commit).slice(0, 150)}`)
  }
}

// ---------------------------------------------------------------------------
// 平台 REST（签发 / 音频中转 / complete）
// ---------------------------------------------------------------------------

async function restCall(origin, key, path, { json, formData } = {}) {
  const headers = { Authorization: `Bearer ${key}` }
  let body
  if (formData) {
    body = formData
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json ?? {})
  }
  let resp
  try {
    resp = await fetch(`${origin}${path}`, { method: 'POST', headers, body })
  } catch (error) {
    throw new UploadError(`连不上瞬镜服务（${origin}）：${String(error?.message ?? error)}`)
  }
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new UploadError(data?.detail ? String(data.detail) : `平台接口 HTTP ${resp.status}`)
  return data
}

// ---------------------------------------------------------------------------
// 主入口：本地文件 → obj_name 引用
// ---------------------------------------------------------------------------

/** STS 凭证键名归一（VOD 驼峰；兼容下划线风格）。 */
function normalizeSts(raw) {
  const pick = (...keys) => {
    for (const k of keys) if (raw?.[k]) return raw[k]
    return ''
  }
  return {
    accessKeyId: pick('access_key_id', 'AccessKeyId'),
    secretAccessKey: pick('secret_access_key', 'SecretAccessKey'),
    sessionToken: pick('session_token', 'SessionToken'),
  }
}

/**
 * 上传本地参考素材并领取 obj_name 引用（可复用；类型按扩展名自动识别）。
 * @param {object} opts {filePath, key, mcpUrl} —— key=API 密钥明文，
 *   mcpUrl=插件配置的 MCP 地址（origin 推导 REST base）
 * @returns {Promise<{obj_name,kind,meta}>}
 */
export async function uploadReference({ filePath, key, mcpUrl }) {
  const ext = extname(filePath).toLowerCase()
  const resolvedKind = EXT_KIND[ext]
  if (!resolvedKind) {
    throw new UploadError(`不支持的文件类型 ${ext || '(无扩展名)'}：仅支持 `
      + 'jpg/jpeg/png/webp/gif（图片）、mp4/mov/webm（视频）与 mp3/wav（音频）')
  }
  const mime = EXT_MIME[ext]
  if (!mime) throw new UploadError(`无法识别 ${filePath} 的 MIME 类型`)

  let size
  try {
    size = (await stat(filePath)).size
  } catch (error) {
    throw new UploadError(`读不到本地文件 ${filePath}：${String(error?.message ?? error)}`)
  }
  if (size <= 0) throw new UploadError('文件为空')
  if (size > MAX_BYTES) throw new UploadError(`文件超过 50MB 上限（${size} 字节）`)

  const origin = new URL(mcpUrl).origin
  const ticket = await restCall(origin, key, '/openapi/v1/upload-tickets',
    { json: { kind: resolvedKind, content_type: mime, size_bytes: size } })
  if (!Number.isInteger(ticket?.ticket_id)) throw new UploadError('签发响应缺少 ticket_id')

  if (resolvedKind === 'audio') {
    // 音频中转：multipart 由平台落 S3（ffprobe 复核时长）
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), extname(filePath) || 'file')
    const done = await restCall(origin, key, `/openapi/v1/upload-tickets/${ticket.ticket_id}/data`,
      { formData: form })
    if (!done?.obj_name) throw new UploadError('平台未返回 obj_name')
    return { obj_name: done.obj_name, kind: resolvedKind, meta: done.meta ?? {} }
  }

  // 图片直传 ImageX / 视频直传 VOD（字节不过平台 API）
  const sts = normalizeSts(ticket?.credentials)
  if (!sts.accessKeyId || !sts.secretAccessKey) throw new UploadError('签发响应缺少 STS 凭证')
  const bytes = await readFile(filePath)
  if (resolvedKind === 'image') {
    await uploadImagex(sts, ticket.service_id, ticket.obj_name, bytes)
    const done = await restCall(origin, key, `/openapi/v1/upload-tickets/${ticket.ticket_id}/complete`,
      { json: {} })
    if (!done?.obj_name) throw new UploadError('平台未返回 obj_name')
    return { obj_name: done.obj_name, kind: resolvedKind, meta: done.meta ?? {} }
  }
  const vid = await uploadVod(sts, ticket.space_name, ticket.obj_name, ext, bytes)
  const done = await restCall(origin, key, `/openapi/v1/upload-tickets/${ticket.ticket_id}/complete`,
    { json: { vid } })
  if (!done?.obj_name) throw new UploadError('平台未返回 obj_name')
  return { obj_name: done.obj_name, kind: resolvedKind, meta: done.meta ?? {} }
}
