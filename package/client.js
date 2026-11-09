/**
 * solmirror-dsh 浏览器模块（v0.4.0；0.10.3 修媒体卡 id 反查重试）
 *
 * 1) 在 dsh 设置面板注册「瞬镜开放平台」自定义页：
 *   - 连接状态徽章 + 最近错误
 *   - API 密钥（保存进 dsh 凭据存储，回显只显示"已配置"，永不显示明文）
 *   - 服务器地址（写入插件 volatile 配置，热生效）
 *   - 可见模型组勾选（写入插件配置；宿主侧实时过滤 list_models 并拦截越组生成）
 *   - 测试连接（宿主侧用当前密钥做一次性 MCP 握手）
 *
 * 2) 接管 generate_video 工具行的渲染（tool.call.toolview 键控插槽）：
 *   dsh 原生气泡只有图片画廊、没有视频播放器；本 toolview 在气泡内展示
 *   生成进度，成功后内嵌 <video> 直接播放（签名 URL 经宿主半边本地路由
 *   动态取新，过期也能回放历史会话）。
 *
 * 格式约定：dsh client 模块表工厂（window.__ModuleLoader__.load），参照
 * deepseek-harness apps/web/tests/fixtures/plugins/fixture-live-client。
 */
window.__ModuleLoader__.load({
  id: 'dsh-solmirror',
  factory(require) {
    const React = require('react')

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid rgba(128,128,140,0.28)', borderRadius: '10px', padding: '12px 14px' },
      cardTitle: { fontWeight: 600, marginBottom: '6px' },
      muted: { color: 'rgba(160,160,175,0.95)', fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px', minWidth: '200px', padding: '6px 9px', borderRadius: '8px',
        border: '1px solid rgba(128,128,140,0.35)', background: 'transparent',
        color: 'inherit', fontSize: '13px', outline: 'none',
      },
      button: {
        padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(128,128,140,0.4)',
        background: 'rgba(128,128,140,0.14)', color: 'inherit', fontSize: '13px', cursor: 'pointer',
      },
      primary: { background: 'rgba(64,120,220,0.9)', borderColor: 'transparent', color: '#fff' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '999px', fontSize: '12px' },
      msgOk: { color: '#3fbf6f' },
      msgErr: { color: '#e0566b' },
      groupRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', cursor: 'pointer' },
      groupsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 14px', marginTop: '6px' },
      tag: { fontSize: '11px', padding: '1px 7px', borderRadius: '6px', background: 'rgba(128,128,140,0.18)', color: 'rgba(170,170,185,0.95)' },
    }

    function badgeOf(status) {
      if (status === 'connected') return { text: '已连接', color: '#2f9e5f', bg: 'rgba(47,158,95,0.14)' }
      if (status === 'connecting') return { text: '连接中…', color: '#c99a2e', bg: 'rgba(201,154,46,0.14)' }
      if (status === 'error') return { text: '未连接', color: '#e0566b', bg: 'rgba(224,86,107,0.14)' }
      return { text: '未启用', color: 'rgba(160,160,175,0.95)', bg: 'rgba(128,128,140,0.14)' }
    }

    function SolmirrorSection(ops) {
      const [snap, setSnap] = React.useState(null)
      const [keyInput, setKeyInput] = React.useState('')
      const [urlDraft, setUrlDraft] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [draftsReady, setDraftsReady] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [testResult, setTestResult] = React.useState(null)

      const note = (kind, text) => setMsg({ kind, text })

      const refresh = async () => {
        try {
          const next = await ops.fetchStatus()
          setSnap(next)
          if (!draftsReady) {
            setUrlDraft(next.url ?? '')
            setSelected(next.visibleGroups ?? [])
            setDraftsReady(true)
          }
        } catch (error) {
          note('err', `读取状态失败：${String(error?.message ?? error)}`)
        }
      }

      React.useEffect(() => { void refresh() }, [])

      const withBusy = async (tag, fn) => {
        setBusy(tag)
        try { await fn() } finally { setBusy(''); void refresh() }
      }

      // 保存只保存，不主动触发连接（owner 拍板 2026-11-08）：验证连接用下方
      // 「测试连接」；常驻连接由宿主侧 10s 漂移对账自动换用新密钥/新地址。
      const saveKey = () => withBusy('key', async () => {
        const value = keyInput.trim()
        if (!value) return note('err', '请先粘贴密钥（sk- 开头）')
        const error = await ops.saveKey(value)
        if (error) return note('err', `保存失败：${error}`)
        setKeyInput('')
        note('ok', '密钥已保存，连接将在几秒内自动切换；可点「测试连接」立即验证')
      })

      const saveUrl = () => withBusy('url', async () => {
        const value = urlDraft.trim()
        if (!value) return note('err', '地址不能为空')
        const error = await ops.saveConfig('url', value)
        if (error) return note('err', `保存失败：${error}`)
        note('ok', '地址已保存，连接将在几秒内自动切换；可点「测试连接」立即验证')
      })

      const saveGroups = () => withBusy('groups', async () => {
        const error = await ops.saveConfig('visibleGroups', selected ?? [])
        if (error) return note('err', `保存失败：${error}`)
        note('ok', (selected ?? []).length === 0 ? '已恢复全部模型组可见' : `已收窄到 ${selected.length} 个模型组（实时生效，无需重连）`)
      })

      const runTest = () => withBusy('test', async () => {
        const result = await ops.post('/plugins/solmirror/test')
        setTestResult(result)
      })

      const toggleGroup = id => setSelected(prev => {
        const list = prev ?? []
        return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
      })

      const badge = badgeOf(snap?.status ?? 'idle')
      const groups = snap?.groups ?? []
      const allVisible = !selected || selected.length === 0

      return React.createElement('div', { style: S.wrap },
        // 连接状态
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: { ...S.cardTitle, ...S.row, justifyContent: 'space-between' } },
            React.createElement('span', null, '连接状态'),
            React.createElement('span', { style: { ...S.badge, color: badge.color, background: badge.bg } },
              `● ${badge.text}`),
          ),
          React.createElement('div', { style: S.muted },
            snap?.keyConfigured ? 'API 密钥：已配置' : 'API 密钥：未配置（在下方粘贴保存）',
            snap?.url ? `　·　服务地址：${snap.url}` : '',
            snap?.tools?.length ? `　·　已注册工具 ${snap.tools.length} 个` : '',
          ),
          snap?.lastError ? React.createElement('div', { style: { ...S.muted, ...S.msgErr, marginTop: '4px' } }, snap.lastError) : null,
        ),

        // API 密钥
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.cardTitle }, 'API 密钥'),
          React.createElement('div', { style: S.row },
            React.createElement('input', {
              type: 'password', style: S.input, value: keyInput, placeholder: 'sk-…（粘贴后点保存）',
              onChange: e => setKeyInput(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') void saveKey() },
            }),
            React.createElement('button', { type: 'button', style: { ...S.button, ...(keyInput.trim() ? S.primary : {}) }, disabled: busy === 'key', onClick: saveKey },
              busy === 'key' ? '保存中…' : '保存'),
          ),
          React.createElement('div', { style: { ...S.muted, marginTop: '6px' } },
            '密钥只保存在本机 dsh 凭据存储（~/.dsh/.credentials.yaml），不会回显明文、不会写入任何配置文件。'),
        ),

        // 服务器地址
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.cardTitle }, '服务器地址'),
          React.createElement('div', { style: S.row },
            React.createElement('input', {
              type: 'text', style: S.input, value: urlDraft, placeholder: 'https://aigcserver.solmirror.cn/mcp',
              onChange: e => setUrlDraft(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') void saveUrl() },
            }),
            React.createElement('button', { type: 'button', style: S.button, disabled: busy === 'url', onClick: saveUrl },
              busy === 'url' ? '保存中…' : '保存'),
          ),
          React.createElement('div', { style: { ...S.muted, marginTop: '6px' } }, '默认已填好线上地址，一般无需修改；也可以从瞬镜平台「开放平台 → 插件接入」页一键复制。'),
        ),

        // 可见模型组
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: { ...S.cardTitle, ...S.row, justifyContent: 'space-between' } },
            React.createElement('span', null, '可见模型组'),
            React.createElement('span', { style: S.tag }, allVisible ? '当前：全部可见' : `当前：${selected.length} 个组`),
          ),
          groups.length === 0
            ? React.createElement('div', { style: S.muted }, '连接成功后这里会列出平台全部模型组；未连接时不过滤。')
            : React.createElement('div', { style: S.groupsGrid },
              groups.map(g => React.createElement('label', { key: `${g.category}:${g.id}`, style: S.groupRow },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: (selected ?? []).includes(g.id),
                  onChange: () => toggleGroup(g.id),
                }),
                React.createElement('span', null, g.name),
                React.createElement('span', { style: S.tag }, g.category === 'image' ? '图片' : '视频'),
              )),
            ),
          React.createElement('div', { style: { ...S.row, marginTop: '8px' } },
            React.createElement('button', { type: 'button', style: { ...S.button, ...(!allVisible ? S.primary : {}) }, disabled: busy === 'groups', onClick: saveGroups },
              busy === 'groups' ? '保存中…' : '保存可见范围'),
            React.createElement('span', { style: S.muted }, '不勾选任何组 = 全部可见。过滤只影响 agent 看到的目录与生成入口。'),
          ),
        ),

        // 测试连接 + 消息
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('button', { type: 'button', style: S.button, disabled: busy === 'test', onClick: runTest },
              busy === 'test' ? '测试中…' : '测试连接'),
            testResult ? React.createElement('span', { style: testResult.ok ? S.msgOk : S.msgErr },
              testResult.ok ? `✓ ${testResult.message}` : `✗ ${testResult.message}`)
              : React.createElement('span', { style: S.muted }, '用当前保存的密钥向瞬镜服务发一次 MCP 握手。'),
          ),
          msg ? React.createElement('div', { style: { marginTop: '8px', ...(msg.kind === 'ok' ? S.msgOk : S.msgErr) } }, msg.text) : null,
        ))
    }


    // ---- 会话媒体面（v0.5.0：回合尾部 turnTail，不随工具行折叠）----
    // dsh 工具行在回合结束后会被折叠收起，媒体放里面看不见；且原生 UI 没有
    // 视频播放器。本节把「生成中占位框 + 完成的视频/图片」挂在 turnTail——
    // 对话主流里、永远展开。工具行只留一行状态回执。
    const VIDEO_TOOL = 'mcp__solmirror__generate_video'
    const IMAGE_TOOL = 'mcp__solmirror__generate_image'
    const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'review_rejected'])
    const MS = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', lineHeight: 1.5, padding: '4px 0' },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontWeight: 600 },
      tag: { fontSize: '11px', padding: '1px 7px', borderRadius: '6px', background: 'rgba(128,128,140,0.18)', color: 'rgba(170,170,185,0.95)' },
      muted: { color: 'rgba(160,160,175,0.95)', fontSize: '12px' },
      err: { color: '#e0566b', fontSize: '12px' },
      ok: { color: '#2f9e5f' },
      link: { color: 'rgba(90,140,230,0.95)', fontSize: '12px' },
      video: { width: '100%', maxWidth: '420px', borderRadius: '10px', background: '#000', display: 'block' },
      imgRow: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      rowLine: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px', color: 'rgba(165,165,180,0.95)', padding: '2px 0' },
    }

    // 占位框动效：慢速斜向扫光 + 文案呼吸。样式表随模块物化注入一次。
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-solmirror'
    styleTag.textContent = [
      '@keyframes solmirror-sweep { 0% { transform: translateX(-120%);} 100% { transform: translateX(220%);} }',
      '@keyframes solmirror-breathe { 0%,100% { opacity: 0.45;} 50% { opacity: 1;} }',
      '.solmirror-ph { position: relative; overflow: hidden; border-radius: 10px;',
      '  border: 1px solid rgba(128,128,140,0.22); background: rgba(128,128,140,0.10); }',
      '.solmirror-ph-sweep { position: absolute; inset: 0; transform: skewX(-16deg);',
      '  background: linear-gradient(90deg, transparent, rgba(200,205,225,0.07) 45%, rgba(200,205,225,0.12) 50%, rgba(200,205,225,0.07) 55%, transparent);',
      '  animation: solmirror-sweep 2.4s ease-in-out infinite; }',
      '.solmirror-ph-face { position: absolute; inset: 0; display: flex; flex-direction: column;',
      '  align-items: center; justify-content: center; gap: 6px; }',
      '.solmirror-ph-title { font-size: 14px; font-weight: 600; color: rgba(175,178,195,0.95);',
      '  animation: solmirror-breathe 2s ease-in-out infinite; letter-spacing: 2px; }',
      '.solmirror-ph-sub { font-size: 11px; color: rgba(150,153,170,0.8); }',
    ].join('\n')
    document.head.append(styleTag)

    function statusTextOf(status) {
      // 服务端 MCP 返回小写（'generating'/'pending'），此前只匹配大写导致
      // 副文案直接显示英文原文
      const s = String(status ?? '').toLowerCase()
      if (s === 'succeeded') return '已生成'
      if (s === 'failed') return '生成失败'
      if (s === 'review_rejected') return '审核未通过'
      if (s === 'pending' || s === 'preparing') return '排队中'
      if (s === 'reviewing') return '素材审核中'
      if (s === 'generating') return '生成中'
      return status || '查询中'
    }

    function textOf(block) {
      return (block?.content ?? [])
        .filter(item => item && item.type === 'text')
        .map(item => item.text)
        .join('\n')
    }

    // 终态结果短期缓存（0.7.1）：页面重进/历史气泡回看时同 id 媒体卡直接用缓存
    // 渲染、零请求（路由每次现签 URL，签名有效期远大于 TTL，安全）
    const terminalCache = new Map()
    const TERMINAL_CACHE_TTL = 5 * 60 * 1000

    function cachedTerminal(generationId) {
      const hit = terminalCache.get(generationId)
      return hit && Date.now() - hit.at < TERMINAL_CACHE_TTL ? hit.data : null
    }

    function generationIdOf(media, resultText) {
      if (!resultText) return null
      const byText = /generation (\d+)/.exec(resultText)
      if (byText) return Number(byText[1])
      if (media === 'image') {
        const byJson = /"generation_id"\s*:\s*(\d+)/.exec(resultText)
        if (byJson) return Number(byJson[1])
      }
      return null
    }

    function ratioOf(value) {
      const match = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(String(value ?? ''))
      return match ? { w: Number(match[1]), h: Number(match[2]) } : null
    }

    function parseAspect(rawArgs) {
      try {
        const args = JSON.parse(rawArgs ?? '')
        return ratioOf(args?.aspect_ratio)
      } catch { /* 非 JSON 参数按缺省比例 */ }
      return null
    }

    // callId→生成台账 映射（宿主半边私有路由）：模型可见文本已不携带 id，
    // 新会话的媒体面靠这张表反查；旧会话文本里本就有 id，regex 兜底。
    const callsCache = { at: 0, data: {} }
    async function loadCalls() {
      if (Date.now() - callsCache.at < 30_000) return callsCache.data
      try {
        const response = await fetch('/plugins/solmirror/calls', { cache: 'no-store' })
        const data = await response.json()
        if (data && data.ok && data.calls && typeof data.calls === 'object') {
          callsCache.at = Date.now()
          callsCache.data = data.calls
        }
      } catch { /* 映射不可用时旧文本 regex 兜底 */ }
      return callsCache.data
    }

    /** 占位框：跟随生成比例的空白框 + 扫光动效 + 生成中文案。 */
    function Placeholder({ aspect, sub }) {
      const ratio = aspect ?? { w: 16, h: 9 }
      const portrait = ratio.h > ratio.w
      const style = portrait
        ? { height: '360px', width: 'auto', aspectRatio: `${ratio.w} / ${ratio.h}`, maxWidth: '100%' }
        : { width: '100%', maxWidth: '420px', aspectRatio: `${ratio.w} / ${ratio.h}` }
      return React.createElement('div', { className: 'solmirror-ph', style },
        React.createElement('div', { className: 'solmirror-ph-sweep' }),
        React.createElement('div', { className: 'solmirror-ph-face' },
          React.createElement('div', { className: 'solmirror-ph-title' }, '生成中'),
          sub ? React.createElement('div', { className: 'solmirror-ph-sub' }, sub) : null),
      )
    }

    /** 单个生成的媒体卡：轮询本地路由，占位 → 播放器/图片/错误。 */
    function MediaCard({ gen }) {
      const [info, setInfo] = React.useState(() => cachedTerminal(gen.generationId))
      const [netError, setNetError] = React.useState('')
      const generationId = gen.generationId

      React.useEffect(() => {
        if (!generationId) return undefined
        // 缓存命中的终态：零请求。0.10.4：视频卡的 id 经 calls 反查比首渲染晚一拍，
        // useState 初始化器已在 id=null 时跑过（info 恒 null）——只 bail 不回填会让
        // 卡片永久停在"生成中"占位框（切换会话再切回即复现），须先播种再停轮询
        const cached = cachedTerminal(generationId)
        if (cached) {
          setInfo(prev => (prev === null ? cached : prev))
          return undefined
        }
        let stopped = false
        let timer = null
        let failures = 0
        const tick = async () => {
          try {
            const response = await fetch(`/plugins/solmirror/generation/${generationId}`, { cache: 'no-store' })
            const data = await response.json().catch(() => null)
            if (stopped) return
            if (data && data.ok) {
              failures = 0
              setNetError('')
              setInfo(data)
              if (TERMINAL_STATUSES.has(String(data.status).toLowerCase())) {
                terminalCache.set(generationId, { at: Date.now(), data })
                return
              }
            } else {
              failures += 1
              setNetError((data && data.message) || `HTTP ${response.status}`)
            }
          } catch (error) {
            if (stopped) return
            failures += 1
            setNetError(String((error && error.message) || error))
          }
          // API 重启/停机窗口曾把这里打满 20 次后永久停轮询，卡片死在"生成中"、
          // 服务恢复也不自愈——改为指数退避（5s→10s→…→60s 封顶）无限重试，
          // 恢复成功即回到 5s 节奏
          timer = setTimeout(tick, failures === 0 ? 5000 : Math.min(5000 * 2 ** failures, 60000))
        }
        void tick()
        return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
      }, [generationId])

      const isVideo = gen.media === 'video'
      const label = isVideo ? '视频生成' : '图片生成'
      if (gen.error) {
        return React.createElement('div', { style: MS.rowLine },
          React.createElement('span', null, label, ' · 提交未成功'),
          gen.error ? React.createElement('span', { style: MS.err }, gen.error.slice(0, 200)) : null)
      }
      if (!generationId) {
        return React.createElement('div', { style: MS.wrap },
          Placeholder({ aspect: gen.aspect, sub: '已提交' }))
      }
      const status = info ? String(info.status).toLowerCase() : ''
      if (!TERMINAL_STATUSES.has(status)) {
        // 从未拿到过状态且轮询在失败（API 停机/重启窗口）→ 副文案明示在自动重试，
        // 不再让卡看起来像"一直在生成"
        const sub = status ? statusTextOf(status)
          : (netError ? '状态暂时取不到，自动重试中…' : undefined)
        return React.createElement('div', { style: MS.wrap },
          Placeholder({ aspect: gen.aspect, sub }),
          netError && status ? React.createElement('div', { style: MS.muted }, `状态刷新失败：${netError}`) : null)
      }
      if (status !== 'succeeded') {
        return React.createElement('div', { style: MS.wrap },
          React.createElement('div', { style: MS.head },
            React.createElement('span', { style: MS.title }, label),
            React.createElement('span', { style: MS.err }, statusTextOf(status))),
          info && info.error ? React.createElement('div', { style: MS.err }, info.error) : null)
      }
      const urls = (info && Array.isArray(info.urls) ? info.urls : []).map(String).filter(Boolean)
      const children = [
        React.createElement('div', { key: 'head', style: MS.head },
          React.createElement('span', { style: MS.title }, label),
          React.createElement('span', { style: MS.ok }, '已生成')),
      ]
      if (isVideo) {
        const url = urls[0] || (info && info.url) || ''
        if (url) {
          children.push(React.createElement('video', {
            key: 'video', controls: true, preload: 'metadata', src: url, style: MS.video,
          }))
          if (info.summary) children.push(React.createElement('div', { key: 'summary', style: MS.muted }, info.summary))
          children.push(React.createElement('a', { key: 'open', href: url, target: '_blank', rel: 'noreferrer', style: MS.link }, '在新标签页打开'))
        }
      } else if (urls.length) {
        children.push(React.createElement('div', { key: 'imgs', style: MS.imgRow },
          urls.map((url, index) => React.createElement('a', {
            key: index, href: url, target: '_blank', rel: 'noreferrer', style: { display: 'block', borderRadius: '10px' },
          },
          React.createElement('img', {
            src: url, alt: `生成图 ${index + 1}`, loading: 'lazy',
            style: { display: 'block', maxWidth: '280px', maxHeight: '360px', borderRadius: '10px' },
          })))))
        if (info.summary) children.push(React.createElement('div', { key: 'summary', style: MS.muted }, info.summary))
      }
      if (netError) children.push(React.createElement('div', { key: 'net', style: MS.muted }, `状态刷新失败：${netError}`))
      return React.createElement('div', { style: MS.wrap }, ...children)
    }

    /** 从会话快照收集本回合的 solmirror 生成（含运行中与子调用）。 */
    function collectGenerations(snapshot, turnNumber, callsMap) {
      const found = []
      const seen = new Set()
      const visit = block => {
        if (!block || typeof block !== 'object') return
        const subCalls = Array.isArray(block.subCalls) ? block.subCalls : []
        for (const child of subCalls) visit(child)
        // ToolCallBlock 三态：ToolResultNode 用 kind:'tool-result' 标记（无 phase 字段），
        // Preparing/Started 才有 phase。结果相名字官方解析顺序=call.name 优先
        // （ui-tool ToolCallTree.callName）。0.5.0 曾误判 block.phase==='result' 恒假，
        // genId 解析不出、占位框永远停在"已提交"不轮询。
        const isResult = typeof block.kind === 'string' && 'content' in block
        const name = String(isResult ? (block.call?.name ?? block.name ?? '') : (block.name ?? ''))
        if (name !== VIDEO_TOOL && name !== IMAGE_TOOL) return
        const callId = String(block.callId ?? '')
        if (callId && seen.has(callId)) return
        if (callId) seen.add(callId)
        const resultText = isResult && !block.isError ? textOf(block) : ''
        const media = name === VIDEO_TOOL ? 'video' : 'image'
        const argsRaw = isResult ? block.call?.argsRaw : block.argsRaw
        const mapped = callId ? callsMap?.[callId] : undefined
        found.push({
          callId: callId || `${name}-${found.length}`,
          media,
          // 提交就失败的调用（400 参数错/越组拦截等）没有 generationId，此前按
          // 占位框渲染成"生成中"——用户看着像还有一个视频在跑，实际根本没提交
          // 成功。错误文本带出去渲染成一行失败回执，与 toolRowView 错误分支同语义
          error: isResult && block.isError ? textOf(block) : '',
          // 新会话文本无 id → 私有映射反查；旧会话/降级路径文本带 id → regex
          generationId: generationIdOf(media, resultText)
            ?? (Number.isInteger(mapped?.generationId) ? mapped.generationId : null),
          aspect: parseAspect(argsRaw) ?? ratioOf(mapped?.aspect),
        })
      }
      try {
        const keys = snapshot?.locations?.getTurn?.(turnNumber) ?? []
        for (const key of keys) {
          const node = snapshot?.nodes?.get?.(key)
          if (node?.kind !== 'tool-call') continue
          visit(node?.data?.root)
        }
      } catch { /* 快照结构异常时静默不渲染 */ }
      return found
    }

    /** 回合尾部的媒体面：本回合每条 solmirror 生成一张媒体卡。 */
    function SolmirrorTurnTail(props) {
      const turnNumber = props?.turn?.turn
      const [calls, setCalls] = React.useState(null)
      const gens = typeof props.useChat === 'function'
        ? props.useChat(snapshot => collectGenerations(snapshot, turnNumber, calls))
        : collectGenerations(null, turnNumber, calls)
      React.useEffect(() => {
        if (!gens || gens.length === 0) return undefined
        if (gens.every(gen => gen.generationId)) return undefined
        let stopped = false
        // 0.10.3：id 反查此前是挂载时一次性 loadCalls——静置会话（切走再切回）没有
        // 新快照就不会再渲染，那次 fetch 偶发失败后永无重试，generationId 恒空，
        // 卡片连轮询都不启动、永远停在"生成中"占位框（失败视频切换会话即复现）。
        // 改为定时重试直到本回合全部解析出 id；loadCalls 自带 30s TTL，实际拉取
        // 频率 ≤30s 一次；全部解析后本 effect 重建即清掉 interval。
        const attempt = () => {
          loadCalls().then(data => {
            if (stopped || !data || Object.keys(data).length === 0) return
            // 函数式更新：同一引用不触发渲染，避免 30s TTL 命中时的无谓重挂
            setCalls(prev => (prev === data ? prev : data))
          }).catch(() => { /* 重试由 interval 驱动 */ })
        }
        attempt()
        const timer = setInterval(attempt, 10_000)
        return () => { stopped = true; clearInterval(timer) }
      }) // 无依赖数组：gens 每快照变化都是新引用；重试有 30s TTL 兜底，开销可控
      if (!gens || gens.length === 0) return null
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        gens.map(gen => React.createElement(MediaCard, { key: gen.callId, gen })))
    }

    /** 工具行视图（0.7.0）：turn-tail 节点只在 turn/end 发布（chat-snapshot-builder
     *  原话"publishes its turn-tail Node on turn/end"），活跃回合里回合尾部不存在——
     *  图片工具内最多等 60s，这段窗口的媒体面就挂工具行（toolview 键控替换整行）：
     *  进行中=跟随比例占位框、结果相=媒体卡（图片常已是终态直接出图墙；视频交给
     *  轮询）。回合收尾后工具行随 process 折叠、回合尾部的媒体卡无缝接管。
     *  id 解析不出（新式视频文本无 id）或错误态回退一行回执；台账 id 不上 UI。 */
    function toolRowView(media) {
      return function ToolRow(props) {
        const phase = props.phase
        const block = props.block
        const label = media === 'video' ? '视频生成' : '图片生成'
        if (phase !== 'result') {
          // preparing 相参数可能不全（比例取不到就 16:9 兜底）；start 相=已提交待出
          return React.createElement('div', { style: MS.wrap },
            Placeholder({
              aspect: parseAspect(block && block.argsRaw),
              sub: phase === 'preparing' ? '提交中…' : '已提交',
            }))
        }
        if (block.isError) {
          const resultText = textOf(block)
          return React.createElement('div', { style: MS.rowLine },
            React.createElement('span', null, label, ' · 失败'),
            resultText ? React.createElement('span', { style: MS.err }, resultText.slice(0, 200)) : null)
        }
        const resultText = textOf(block)
        const gen = {
          callId: String(props.callId ?? ''),
          media,
          generationId: generationIdOf(media, resultText),
          aspect: parseAspect(block.call && block.call.argsRaw),
        }
        // 结果相文本带 id（图片 JSON 必带；视频降级/旧文本带）→ 行内媒体卡；
        // 新式视频文本无 id → 一行回执（尾部卡有映射反查全通道，接管展示）
        if (gen.generationId) return React.createElement(MediaCard, { gen })
        return React.createElement('div', { style: MS.rowLine },
          React.createElement('span', null, label, ' · 已提交'))
      }
    }

    return {
      inject: ['slots', 'remote', 'remote.credentials', 'remote.settings'],
      apply(ctx) {
        const injected = () => ({
          async fetchStatus() {
            const response = await fetch('/plugins/solmirror/status', { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          },
          async post(path) {
            const response = await fetch(path, { method: 'POST' })
            return response.json().catch(() => ({}))
          },
          async saveKey(value) {
            const response = await ctx.remote.credentials.set('SOLMIRROR_API_KEY', value)
            return response.ok ? null : response.error.message
          },
          async saveConfig(field, value) {
            const response = await ctx.remote.settings.mutate(
              'solmirror', [{ op: 'set', path: [field], value }], undefined)
            return response.ok ? null : response.error.message
          },
        })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'solmirror',
          order: 40,
          label: () => '瞬镜开放平台',
          inject: injected,
        }, SolmirrorSection))
        // 媒体面（占位/播放器/图片）挂回合尾部：对话主流、不随工具行折叠
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
          { name: 'conversation.chat.turnTail', id: 'solmirror' }, SolmirrorTurnTail))
        // 工具行=活跃回合的媒体面（占位框/出图墙）；回合收尾后随行折叠、尾部卡接管
        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = [
            ctx.slots.register({ name: 'tool.call.toolview', key: VIDEO_TOOL }, toolRowView('video')),
            ctx.slots.register({ name: 'tool.call.toolview', key: IMAGE_TOOL }, toolRowView('image')),
          ]
          return () => { for (const dispose of disposers) dispose() }
        })
      },
    }
  },
})
