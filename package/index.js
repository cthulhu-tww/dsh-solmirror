/**
 * dsh-solmirror 宿主入口
 *
 * 自持 MCP 连接（StreamableHTTPClientTransport + Bearer 密钥），把服务端工具注册到
 * ToolRuntime（公开名 mcp__solmirror__<raw>），并按"可见模型组"过滤：
 *   - list_models 结果按 visibleGroups 收窄
 *   - generate_image / generate_video 对不可见组的模型直接报错，不打上游
 *
 * generate_video 由 dsh 原生后台任务跟进（宿主未组合 jobs 服务时降级为
 * "提交即返 + agent 轮询"）。密钥解析：插件配置 apiKey → dsh 凭据存储
 * （apiKeyEnv 引用）；明文只在内存拼 Authorization 头。
 *
 * dsh webserver 管理路由（与网页同源）：
 *   GET  /plugins/solmirror/status     连接状态 + 目录快照
 *   POST /plugins/solmirror/test       一次性握手（测试连接）
 *   POST /plugins/solmirror/reconnect  强制重连（手动端点）
 *   GET  /plugins/solmirror/calls      callId→generationId 映射（媒体卡反查）
 *   GET  /plugins/solmirror/generation/{id}  状态 + 媒体地址
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { uploadReference, UploadError } from './upload.js'

// 包名：须与 package.json / cordis.patch.yml 保持一致
export const name = 'dsh-solmirror'

/** 依赖宿主服务：工具注册、凭据解析、webserver 管理路由（base+web-app 组合均提供）。 */
export const inject = ['tools', 'credentials', 'webServer']

export const Config = z.object({
  url: z.string().default('https://aigcserver.solmirror.cn/mcp').volatile()
    .description('瞬镜 MCP 服务地址'),
  apiKey: z.string().role('secret').volatile()
    .description('API 密钥（sk- 开头）。直接粘贴到这里，或留空走下方凭据引用'),
  apiKeyEnv: z.string().role('credential-ref').default('SOLMIRROR_API_KEY').volatile()
    .description('凭据引用名：设置页保存的密钥存在 dsh 凭据存储的这个名下'),
  visibleGroups: z.array(z.string()).volatile()
    .description('可见模型组 id 列表；留空 = 全部可见（在配置页勾选）'),
  toolCallTimeoutMs: z.number().step(1).min(5000).max(3600000).default(300000).volatile()
    .description('单个工具调用超时（毫秒）；图片生成内部等待较长，默认 5 分钟'),
  videoJobPollMs: z.number().step(1).min(3000).max(120000).default(15000).volatile()
    .description('视频后台任务的轮询间隔（毫秒），默认 15 秒'),
  videoJobTimeoutMs: z.number().step(1).min(60000).max(7200000).default(1200000).volatile()
    .description('视频后台任务的最长等待（毫秒），超时收尾但平台生成继续，默认 20 分钟'),
  disabled: z.boolean().default(false).volatile()
    .description('停用：断开连接并注销全部工具'),
})

const SERVER_NAME = 'solmirror'

// callId→generationId 私有映射：工具返回文本不携带 id，气泡媒体面经
// /plugins/solmirror/calls 路由反查本表；持久化到 ~/.dsh/plugins/，重启与历史会话回放有效。
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 文件名历史沿用，勿改（旧会话映射兼容）
const CALLS_FILE = join(homedir(), '.dsh', 'plugins', 'solmirror-dsh-calls.json')

export function apply(ctx, config) {
  /** 全部连接态集中在此；volatile 字段一律 .get() 实时读，改配置无需重启。 */
  const state = {
    client: null,
    disposers: new Map(),
    connectPromise: null,
    connectedUrl: null,
    connectedKey: null,
    status: 'idle', // idle | connecting | connected | error
    lastError: null,
    catalog: { groups: [], modelGroup: new Map() },
    disposed: false,
  }
  const callMap = new Map()
  try {
    const stored = JSON.parse(readFileSync(CALLS_FILE, 'utf8'))
    for (const [callId, entry] of Object.entries(stored ?? {})) {
      if (entry && Number.isInteger(entry.generationId)) callMap.set(callId, entry)
    }
  } catch { /* 首次运行/文件损坏：空表起步 */ }

  function recordCall(callId, entry) {
    if (!callId || !Number.isInteger(entry.generationId)) return
    callMap.set(String(callId), entry)
    if (callMap.size > 1000) { // 有界：只留最近一千条
      for (const key of callMap.keys()) {
        callMap.delete(key)
        if (callMap.size <= 1000) break
      }
    }
    try {
      writeFileSync(CALLS_FILE, JSON.stringify(Object.fromEntries(callMap)))
    } catch (error) { ctx.logger.warn(`solmirror: 调用映射写盘失败：${describeError(error)}`) }
  }

  const readUrl = () => String(config.url.get() ?? '').trim() || null

  async function readKey() {
    const direct = String(config.apiKey.get() ?? '').trim()
    if (direct) return { key: direct, source: 'config' }
    const refName = String(config.apiKeyEnv.get() ?? '').trim()
    if (refName) {
      try {
        // resolve 返回 {value, source}，须取 .value 作密钥明文
        const resolved = await ctx.credentials.resolve(credentialRef(refName))
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (value) return { key: String(value).trim(), source: `credential:${resolved.source ?? '?'}` }
      } catch (error) {
        ctx.logger.warn(`solmirror: 凭据解析失败: ${String(error)}`)
      }
    }
    return { key: null, source: null }
  }

  /** 当前可见组集合；null = 不过滤（全部可见）。 */
  const allowedGroups = () => {
    const list = config.visibleGroups.get()
    return Array.isArray(list) && list.length ? new Set(list.map(String)) : null
  }

  function disposeTools() {
    for (const dispose of state.disposers.values()) dispose()
    state.disposers = new Map()
  }

  async function closeClient() {
    const client = state.client
    state.client = null
    try { await client?.close() } catch { /* 断开途中的传输错误忽略 */ }
  }

  function describeError(error) {
    const text = String(error?.message ?? error ?? '')
    if (/\b(401|403)\b|unauthorized|forbidden/i.test(text)) return '鉴权失败：密钥无效、未创建或已删除'
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|timeout/i.test(text)) {
      return `连不上瞬镜服务（检查地址与本机后端）：${text}`
    }
    return text || '未知错误'
  }

  /** 建立连接并完成一次工具同步（含目录预热）。串行化，避免并发双连接。 */
  function connect() {
    if (state.connectPromise) return state.connectPromise
    state.connectPromise = (async () => {
      disposeTools()
      await closeClient()
      state.connectedUrl = null
      state.connectedKey = null
      if (config.disabled.get()) { state.status = 'idle'; state.lastError = null; return }

      const url = readUrl()
      const { key, source } = await readKey()
      if (!url) { state.status = 'error'; state.lastError = '未配置服务器地址'; return }
      if (!key) {
        state.status = 'error'
        state.lastError = '未配置 API 密钥：在 dsh 设置 → 瞬镜开放平台 粘贴保存'
        return
      }
      state.status = 'connecting'
      state.lastError = null
      try {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${key}` } },
        })
        const client = new Client({ name: 'dsh-solmirror', version: '0.11.0' })
        await client.connect(transport)
        state.client = client
        state.connectedUrl = url
        state.connectedKey = key

        // 工具同步：generate_video 用原生后台任务包装，其余走 createMcpToolDefinition；
        // 可见性过滤包在每个工具的 call/execute 里做。
        const listed = await client.listTools()
        const next = new Map()
        for (const tool of listed.tools ?? []) {
          const publicName = `mcp__${SERVER_NAME}__${tool.name}`
          if (next.has(publicName)) continue
          next.set(publicName, tool.name === 'generate_video'
            ? videoToolDefinition(tool)
            : createMcpToolDefinition(ctx, {
              name: publicName,
              rawName: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              taskRequired: tool.execution?.taskSupport === 'required',
              call: (args, execution) => callUpstream(client, tool, args, execution),
            }))
        }
        const disposers = new Map()
        // 本地工具：参考素材上传（文件字节不过 MCP——参数走路径，上传走 REST/直传）
        next.set(`mcp__${SERVER_NAME}__upload_reference`, uploadToolDefinition())
        try {
          for (const [publicName, definition] of next) {
            disposers.set(publicName, ctx.tools.register(definition))
          }
        } catch (error) {
          // 命名冲突（外部占了 mcp__solmirror__ 前缀）：整代回滚，宁可零工具不可半套
          for (const dispose of disposers.values()) dispose()
          throw new Error(`工具注册失败（${String(error)}）`)
        }
        state.disposers = disposers

        try { await refreshCatalog(client) } catch { /* 目录预热失败不阻断连接，拦截守卫降级 */ }

        state.status = 'connected'
        state.lastError = null
        ctx.logger.info(`solmirror: 已连接 ${url}（密钥来源 ${source}），注册 ${disposers.size} 个工具`)
      } catch (error) {
        await closeClient()
        disposeTools()
        state.status = 'error'
        state.lastError = describeError(error)
        ctx.logger.warn(`solmirror: 连接失败: ${state.lastError}`)
      }
    })().finally(() => { state.connectPromise = null })
    return state.connectPromise
  }

  /** 拉一次服务端目录（已按平台路由可见性过滤），刷新勾选列表与组归属索引。 */
  async function refreshCatalog(client) {
    const result = await client.callTool({ name: 'list_models', arguments: {} }, { timeout: 30_000 })
    applyCatalogPayload(catalogPayloadOf(result))
  }

  // 服务端作废长会话时 callTool 报会话类错误而状态仍停在 connected；命中特征即重连重试。
  const SESSION_DEAD = /no valid session|session id|session terminated|invalid session|\b404\b|not found/i

  /** 统一 MCP 调用出口：会话失效自动重建常驻连接并重试一次。 */
  async function callMcp(name, args, opts) {
    const attempt = () => {
      const client = state.client
      if (!client) throw new Error('瞬镜 MCP 未连接：请到 dsh 设置 → 瞬镜开放平台 检查连接')
      return client.callTool({ name, arguments: (args && typeof args === 'object') ? args : {} }, opts)
    }
    try {
      return await attempt()
    } catch (error) {
      if (!SESSION_DEAD.test(String(error?.message ?? error))) throw error
      ctx.logger.warn(`solmirror: MCP 会话失效（${String(error?.message ?? error)}），重连后重试`)
      await connect()
      return attempt()
    }
  }

  function catalogPayloadOf(result) {
    return result?.structuredContent
      ?? safeJsonParse(Array.isArray(result?.content) ? result.content[0]?.text : null)
  }

  /** 按 obj_name 现取临时媒体地址；失败返回空串（调用方降级文案）。 */
  async function fetchMediaUrl(objName) {
    if (!objName) return ''
    try {
      const result = await callMcp('get_media_url', { obj_name: String(objName) }, { timeout: 30_000 })
      const payload = result?.structuredContent
        ?? safeJsonParse(Array.isArray(result?.content) ? result.content[0]?.text : null)
      return String(payload?.url ?? '')
    } catch (error) {
      ctx.logger.warn(`solmirror: 取媒体地址失败 ${objName}: ${describeError(error)}`)
      return ''
    }
  }

  function applyCatalogPayload(payload) {
    if (!payload) return
    const groups = []
    const modelGroup = new Map()
    for (const category of ['image', 'video']) {
      for (const group of payload[category] ?? []) {
        const id = String(group?.group ?? '')
        if (!id) continue
        groups.push({ id, name: String(group?.name ?? id), category })
        for (const model of group?.models ?? []) {
          for (const key of ['id', 'name', 'model']) {
            const value = model?.[key]
            if (typeof value === 'string' && value) modelGroup.set(value, id)
          }
        }
      }
    }
    state.catalog = { groups, modelGroup }
  }

  function safeJsonParse(text) {
    if (typeof text !== 'string') return null
    try { return JSON.parse(text) } catch { return null }
  }

  /** 参数对应的模型组：显式 group 优先，否则查目录索引（未知模型返回 null 不拦，交给服务端校验）。 */
  function resolveGroupOf(args) {
    if (args?.group) return String(args.group)
    const model = String(args?.model ?? '')
    return model ? state.catalog.modelGroup.get(model) ?? null : null
  }

  /** 生成类工具的可见组守卫：越组时返回面向 agent 的错误文案，放行返回 null。 */
  function visibilityViolation(toolName, args) {
    const allow = allowedGroups()
    if (!allow || (toolName !== 'generate_image' && toolName !== 'generate_video')) return null
    const group = resolveGroupOf(args)
    if (group && !allow.has(group)) {
      return `模型 ${String(args?.model ?? '')}（组 ${group}）不在插件设置的可见模型范围内。`
        + ' 请在 dsh 设置 → 瞬镜开放平台 勾选该组，或清空选择恢复全部可见。'
    }
    return null
  }

  async function callUpstream(_client, tool, args, execution) {
    const violation = visibilityViolation(tool.name, args)
    if (violation) {
      return { isError: true, content: [{ type: 'text', text: violation }] }
    }
    const result = await callMcp(tool.name, args,
      { signal: execution.signal, timeout: config.toolCallTimeoutMs.get(), toolDefinition: tool })
    if (tool.name === 'generate_image') {
      // 登记私有映射（媒体面经 /plugins/solmirror/calls 反查）
      try {
        const payload = result?.structuredContent ?? catalogPayloadOf(result)
        if (Number.isInteger(payload?.generation_id)) {
          recordCall(execution.callId, {
            generationId: payload.generation_id,
            media: 'image',
            aspect: String(args?.aspect_ratio ?? ''),
          })
        }
      } catch { /* 登记失败不影响返回 */ }
    }
    if (tool.name === 'list_models') {
      // 每次调用同步服务端目录，勾选列表/组归属索引即时跟上
      try { applyCatalogPayload(catalogPayloadOf(result)) } catch { /* 刷新失败不影响本次返回 */ }
      const allow = allowedGroups()
      if (allow) return filterCatalogResult(result, allow)
    }
    return result
  }

  /** 按可见组收窄 list_models 结果（structuredContent 与首块 JSON 文本同步重写）。 */
  function filterCatalogResult(result, allow) {
    try {
      // structuredContent 缺席时回退解析首块 JSON 文本（部分工具只回 text 块）
      const payload = result?.structuredContent ?? catalogPayloadOf(result)
      if (!payload || (!Array.isArray(payload.image) && !Array.isArray(payload.video))) return result
      const filtered = {}
      for (const category of ['image', 'video']) {
        filtered[category] = (payload[category] ?? []).filter(group => allow.has(String(group?.group)))
      }
      const content = Array.isArray(result.content)
        ? result.content.map((block, index) => index === 0 && block?.type === 'text'
          ? { ...block, text: JSON.stringify(filtered) }
          : block)
        : result.content
      return { ...result, content, structuredContent: filtered }
    } catch {
      return result
    }
  }

  // ---- generate_video：dsh 原生后台任务包装 ----
  //
  // 提交走 MCP（服务端受理即返 generation_id），随后在 dsh 的 jobs 注册表挂一个
  // 跟进 job 轮询 get_generation；完成/失败经通知链以用户消息推给主代理，agent
  // 无需自己轮询。宿主未组合 jobs 服务（或调用无 agent 上下文）时降级为
  // “提交即返 + agent 轮询”。

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  function extractText(result) {
    return Array.isArray(result?.content)
      ? result.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      : ''
  }

  /** 字节数人性化（1.0MB / 345KB / 890B）。 */
  function formatSize(bytes) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n <= 0) return ''
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
    if (n >= 1024) return `${Math.round(n / 1024)}KB`
    return `${n}B`
  }

  /** 生成结果的一行媒体摘要：积分 | 分辨率 | 比例 | 时长 | 大小（缺什么跳什么）。 */
  function mediaSummary(payload) {
    const parts = []
    if (payload?.points_charged !== null && payload?.points_charged !== undefined) {
      parts.push(`积分 ${payload.points_charged}`)
    }
    const v = payload?.video ?? payload ?? {}
    if (v.resolution) parts.push(`分辨率 ${v.resolution}`)
    if (v.aspect_ratio) parts.push(`比例 ${v.aspect_ratio}`)
    if (v.width && v.height) parts.push(`尺寸 ${v.width}x${v.height}`)
    if (v.duration) parts.push(`时长 ${v.duration}s`)
    const size = formatSize(v.file_size)
    if (size) parts.push(`大小 ${size}`)
    return parts.join(' | ')
  }

  function videoToolDefinition(tool) {
    return {
      name: `mcp__${SERVER_NAME}__generate_video`,
      description: '提交视频生成（文生视频/图生视频/参考视频）。提交后立即返回，由 dsh 后台任务'
        + '自动跟进：完成（成功或失败）时你会自动收到含无水印视频地址的通知，无需自行轮询；'
        + '仅当返回 kind=submitted（宿主无后台任务服务）时才用 mcp__solmirror__get_generation 轮询。'
        + '参数取值一律以 mcp__solmirror__list_models 该模型条目为准（各档位不同，勿凭组名猜）：'
        + 'function_type 只认英文枚举 t2v（文生视频）/i2v（图生视频，单首帧）/kf2v（首尾帧，'
        + '首/尾帧图作为参考图传入）/multi-ref（参考视频生成）/edit（视频编辑，须含参考视频）/'
        + 'extend（视频延长，须含参考视频）——中文标签只是展示文案不能传参；缺省按输入推导：'
        + '无输入=t2v；仅图=i2v；带参考视频=multi-ref。resolution 合法值=该模型的 resolutions'
        + '（如 seedance-2.0-mini/fast 仅 480p/720p），缺省用模型默认；duration 档位与 '
        + 'aspect_ratios 同样以 list_models 为准（edit/extend 可传 -1 跟随参考视频）。'
        + 'reference_images / reference_videos 每项为 obj_name（本地文件先调'
        + ' mcp__solmirror__upload_reference 上传获得；可重复引用，没用过的 1 天/用过的 3 天'
        + '有效，过期需重新上传；视频上传时 ≤50MB 且 ≤30 秒）。参考音色音频走'
        + ' reference_audios（仅 list_models 带 reference_audios 能力的模型，须配合参考图/'
        + '视频）：在 prompt 的说话台词处标注（参考音频1）式标记（编号=列表顺序），模型'
        + '会让对应角色用该音色说话。',
      parameters: tool.inputSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['background', 'submitted'] },
            jobId: { type: 'string' },
            generation_id: { type: 'integer' },
            status: { type: 'string' },
          },
          required: ['kind', 'generation_id', 'status'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          // generation id 不进模型可见文本（降级路径除外：无后台任务服务时须拿 id 轮询）
          text: value.kind === 'background'
            ? '视频生成已提交，由 dsh 后台任务自动跟进，完成或失败会自动通知你无水印链接与积分摘要，无需轮询。'
            : `视频生成已提交（generation ${value.generation_id}，状态 ${value.status}）。宿主无后台任务服务，请以 15~30 秒间隔调用 mcp__solmirror__get_generation(generation_id=${value.generation_id}) 轮询到终态。`,
        }],
      },
      async execute(args, exec) {
        const violation = visibilityViolation('generate_video', args)
        if (violation) throw new Error(violation)
        const result = await callMcp('generate_video', args,
          { signal: exec.signal, timeout: config.toolCallTimeoutMs.get(), toolDefinition: tool })
        if (result?.isError) throw new Error(extractText(result) || '提交失败')
        const payload = result?.structuredContent
          ?? safeJsonParse(Array.isArray(result?.content) ? result.content[0]?.text : null)
        const generationId = payload?.generation_id
        if (!generationId) throw new Error(extractText(result) || '提交返回缺少 generation_id')
        recordCall(exec.callId, {
          generationId,
          media: 'video',
          aspect: String(args?.aspect_ratio ?? ''),
        })
        const registry = ctx.get('jobs')
        if (!registry || !exec.agent) {
          return { kind: 'submitted', generation_id: generationId, status: String(payload.status ?? '') }
        }
        const jobId = startVideoJob(registry, exec, args ?? {}, payload)
        return { kind: 'background', jobId, generation_id: generationId, status: String(payload.status ?? '') }
      },
    }
  }

  /** 本地工具：上传参考素材拿 obj_name（可复用）。 */
  function uploadToolDefinition() {
    return {
      name: `mcp__${SERVER_NAME}__upload_reference`,
      description: '上传本地参考素材（图片/视频/音频）拿 obj_name：图片 ≤50MB（jpg/png/webp/gif），'
        + '视频 ≤50MB 且 ≤30 秒（mp4/mov/webm），音频 ≤50MB 且 ≤60 秒（mp3/wav，参考音色）。'
        + '上传成功返回 obj_name——把它填进 mcp__solmirror__generate_image 的'
        + ' reference_images 或 mcp__solmirror__generate_video 的 reference_images /'
        + ' reference_videos / reference_audios 即可作为参考素材，可重复引用：没用过的 1 天、'
        + '引用过的自最后一次使用起 3 天内有效，过期再引用会提示重新上传。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '本地文件的绝对路径；类型按扩展名自动识别（jpg/png/webp/gif=图片、mp4/mov/webm=视频、mp3/wav=参考音频），无需也无法指定类型' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            obj_name: { type: 'string' },
            kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          },
          required: ['obj_name', 'kind'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `参考素材已上传（${{ image: '图片', video: '视频', audio: '参考音频' }[value.kind] ?? value.kind}），`
            + `obj_name ${value.obj_name} `
            + '可重复填入生成工具的 reference_images / reference_videos / reference_audios（没用过 1 天 / 用过 3 天有效）。',
        }],
      },
      async execute(args) {
        const url = readUrl()
        const { key } = await readKey()
        if (!url) throw new Error('未配置服务器地址：请到 dsh 设置 → 瞬镜开放平台 检查连接')
        if (!key) throw new Error('未配置 API 密钥：请到 dsh 设置 → 瞬镜开放平台 粘贴保存')
        const result = await uploadReference({
          filePath: String(args?.file_path ?? ''),
          key,
          mcpUrl: url,
        })
        return { obj_name: result.obj_name, kind: result.kind }
      },
    }
  }

  /** 注册视频跟进 job（轮询 get_generation 到终态）；返回 jobId。 */
  function startVideoJob(registry, exec, args, submitPayload) {
    const generationId = submitPayload.generation_id
    const pollMs = config.videoJobPollMs.get()
    const timeoutMs = config.videoJobTimeoutMs.get()
    const label = `视频 ${String(args.model ?? '')} · ${String(args.prompt ?? '').slice(0, 30)}`.trim()
    return registry.start({
      kind: 'solmirror',
      label,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      owner: exec.agent.id,
      run(job) {
        let cancelled = false
        const done = (async () => {
          const startedAt = Date.now()
          let lastStatus = null
          let failures = 0
          job.append(`已提交，后台跟进中（每 ${Math.round(pollMs / 1000)}s 查询一次）。\n`)
          job.updateProgress('已提交')
          while (true) {
            if (cancelled || state.disposed) {
              job.append('跟进已终止（平台生成未取消，可到 开放平台·生成记录 查看结果）。\n')
              return { status: 'killed', detail: '跟进被终止（平台生成继续）' }
            }
            let payload = null
            try {
              const result = await callMcp('get_generation',
                { generation_id: generationId, include_images: false }, { timeout: 30_000 })
              payload = result?.structuredContent
                ?? safeJsonParse(Array.isArray(result?.content) ? result.content[0]?.text : null)
              if (!payload?.status) throw new Error('返回缺少状态载荷')
              failures = 0
            } catch (error) {
              failures += 1
              if (failures >= 10) {
                const message = describeError(error)
                job.append(`连续 ${failures} 次查询失败（${message}），跟进结束。平台生成未受影响，可到 开放平台·生成记录 查看结果。\n`)
                return { status: 'failed', detail: `查询失败：${message}` }
              }
              await sleep(pollMs)
              continue
            }
            const status = String(payload.status)
            const elapsed = Math.round((Date.now() - startedAt) / 1000)
            if (status !== lastStatus) {
              job.append(`[${elapsed}s] ${status}\n`)
              job.updateProgress(status)
              lastStatus = status
            }
            if (status === 'succeeded') {
              // 载荷只带 obj_name，临时地址经 get_media_url 现取
              const url = await fetchMediaUrl(payload.video?.obj_name)
              const summary = mediaSummary(payload)
              job.append(url ? `生成成功：${url}\n` : '生成成功（地址见对话媒体卡片 / 开放平台·生成记录）。\n')
              if (summary) job.append(`${summary}\n`)
              return {
                status: 'completed',
                detail: '视频生成成功',
                result: [
                  url ? `视频已生成：${url}` : '视频已生成（地址见对话媒体卡片 / 开放平台·生成记录）',
                  summary,
                ].filter(Boolean).join('\n'),
              }
            }
            if (status === 'failed' || status === 'review_rejected') {
              const reason = String(payload.error_message || '')
              job.append(`生成未通过（${status}）：${reason}\n`)
              return { status: 'failed', detail: `${status}${reason ? `: ${reason}` : ''}` }
            }
            if (Date.now() - startedAt > timeoutMs) {
              job.append(`等待超过 ${Math.round(timeoutMs / 60000)} 分钟，跟进收尾。平台生成未取消，可到 开放平台·生成记录 查看结果。\n`)
              return { status: 'failed', detail: '等待超时（平台生成继续）' }
            }
            await sleep(pollMs)
          }
        })()
        return {
          cancel() { cancelled = true },
          done,
        }
      },
    })
  }

  /** 一次性握手测试（不动常驻连接）：配置页「测试连接」。 */
  async function testConnection() {
    const url = readUrl()
    const { key, source } = await readKey()
    // 诊断回显：仅前 8 位 + 长度（排查存错密钥）
    const diag = key ? { keyPrefix: key.slice(0, 8), keyLength: key.length } : {}
    if (!url) return { ok: false, message: '未配置服务器地址', ...diag }
    if (!key) return { ok: false, message: '未配置 API 密钥', ...diag }
    const started = Date.now()
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      })
      const client = new Client({ name: 'dsh-solmirror-test', version: '0.11.0' })
      await client.connect(transport)
      try { await client.close() } catch { /* 关闭竞态忽略 */ }
      return { ok: true, message: `握手成功（${Date.now() - started}ms）`, latencyMs: Date.now() - started, keySource: source, ...diag }
    } catch (error) {
      return { ok: false, message: describeError(error), keySource: source, ...diag }
    }
  }

  async function statusSnapshot() {
    const { key, source } = await readKey()
    const allow = allowedGroups()
    return {
      status: state.status,
      connected: state.status === 'connected',
      lastError: state.lastError,
      url: readUrl(),
      disabled: !!config.disabled.get(),
      keyConfigured: !!key,
      keySource: source,
      visibleGroups: allow ? [...allow] : [],
      visibleAll: !allow,
      groups: state.catalog.groups,
      tools: [...state.disposers.keys()],
      updatedAt: new Date().toISOString(),
    }
  }

  // ---- webserver 管理路由（与 dsh 网页同源；不回传任何密钥材料） ----
  ctx.effect(() => {
    const send = (res, status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    }
    const disposers = [
      ctx.webServer.register({
        kind: 'exact', path: '/plugins/solmirror/status',
        handler: async (req, res) => send(res, 200, await statusSnapshot()),
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/plugins/solmirror/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'POST only' })
          send(res, 200, await testConnection())
        },
      }),
      ctx.webServer.register({
        kind: 'exact', path: '/plugins/solmirror/reconnect',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'POST only' })
          await connect()
          send(res, 200, { ok: state.status === 'connected', status: state.status, message: state.lastError })
        },
      }),
      // callId→generationId 私有映射（媒体面从这里反查）
      ctx.webServer.register({
        kind: 'exact', path: '/plugins/solmirror/calls',
        handler: async (req, res) => {
          const calls = {}
          for (const [callId, entry] of callMap) calls[callId] = entry
          send(res, 200, { ok: true, calls })
        },
      }),
      // 媒体卡数据源：浏览器半边每次挂载/轮询都来这里取最新状态与媒体地址
      //（临时地址会过期，不能把旧 URL 固化进会话渲染）。
      ctx.webServer.register({
        kind: 'prefix', path: '/plugins/solmirror/generation',
        handler: async (req, res) => {
          const tail = String(new URL(req.url, 'http://localhost').pathname).split('/').pop() ?? ''
          const generationId = Number(tail)
          if (!Number.isInteger(generationId) || generationId <= 0) {
            return send(res, 400, { ok: false, message: 'generation id 无效' })
          }
          const client = state.client
          if (!client) return send(res, 503, { ok: false, message: '瞬镜 MCP 未连接' })
          try {
            // 媒体卡只要状态+地址：include_images=false 免去服务端内嵌图片内容，
            // 载荷只带 obj_name，地址经 get_media_url 每次现取
            const result = await callMcp('get_generation',
              { generation_id: generationId, include_images: false }, { timeout: 30_000 })
            const payload = result?.structuredContent
              ?? safeJsonParse(Array.isArray(result?.content) ? result.content[0]?.text : null)
            if (!payload?.status) throw new Error('返回缺少状态载荷')
            // 视频载荷也固定带 images:[]，判别只认 media_type
            const status = String(payload.status)
            let urls = []
            if (status === 'succeeded') {
              const names = payload.media_type === 'image'
                ? (payload.images ?? []).map(item => item?.obj_name).filter(Boolean)
                : payload.video?.obj_name ? [String(payload.video.obj_name)] : []
              urls = (await Promise.all(names.map(fetchMediaUrl))).filter(Boolean)
            }
            send(res, 200, {
              ok: true,
              generation_id: generationId,
              status,
              media_type: payload.media_type === 'image' ? 'image' : 'video',
              url: urls[0] ?? '',
              urls,
              summary: mediaSummary(payload),
              error: payload.error_message ? String(payload.error_message) : '',
            })
          } catch (error) {
            send(res, 502, { ok: false, message: describeError(error) })
          }
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'solmirror: 管理路由')

  // ---- 变更感知：低频漂移对账 ----
  // 保存密钥/地址不主动触发重连（验证走「测试连接」）；新配置由本对账循环在
  // 10s 内静默换用，外部直接改凭据/配置文件同理覆盖。
  ctx.effect(() => {
    const disposers = []
    const timer = setInterval(() => {
      if (state.connectPromise || state.status === 'connecting') return
      if (config.disabled.get()) {
        if (state.client || state.disposers.size) void connect()
        return
      }
      if (readUrl() !== state.connectedUrl) { void connect(); return }
      void (async () => {
        const { key } = await readKey()
        if (key !== state.connectedKey) void connect()
      })()
    }, 10_000)
    disposers.push(() => clearInterval(timer))
    return () => { for (const dispose of disposers) dispose() }
  }, 'solmirror: 变更感知重连')

  ctx.effect(() => () => {
    state.disposed = true
    disposeTools()
    void closeClient()
  }, 'solmirror: 卸载清理')

  void connect()
}
