/**
 * dsh-solmirror 浏览器模块
 *
 * 1) 在 dsh 设置面板注册「瞬镜开放平台」自定义页：
 *   - 连接状态徽章 + 最近错误
 *   - API 密钥（保存进 dsh 凭据存储，回显只显示"已配置"，永不显示明文）
 *   - 服务器地址（写入插件 volatile 配置，热生效）
 *   - 可见模型组勾选（写入插件配置；宿主侧实时过滤 list_models 并拦截越组生成）
 *   - 测试连接（宿主侧用当前密钥做一次性 MCP 握手）
 *
 * 2) 接管生成工具行的渲染（tool.call.toolview 键控插槽）：气泡内展示生成
 *   进度，成功后内嵌 <video> / 出图墙（媒体地址经宿主半边本地路由动态取新，
 *   过期也能回放历史会话）。出图墙与气泡正文去重（0.14.3）：agent 回贴的
 *   markdown 图（同 URL 路径）不再重复出缩略图，全部重复时卡片收敛成回执。
 * 3) 媒体内部预览（2026-11-10 改版）：自绘放大层统一接管图/视频，关闭钮在
 *   媒体盒内 hover 显示（不与窗口按钮打架），图片支持滚轮缩放/拖拽平移——
 *   都不再跳系统浏览器；「在新标签页打开」仍保留为主动出口。
 *
 * 格式约定：dsh client 模块表工厂（window.__ModuleLoader__.load）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-solmirror',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    // 平台共享模块表（宿主 shell 冻结表）里的原生图标；老宿主缺失时
    // 优雅降级：图标位退化成文字符号。
    let IconClose = null
    let IconFullscreen = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      IconClose = primitives.IconCloseOutlineRegular ?? null
      IconFullscreen = primitives.IconFullscreenOutlineRegular ?? null
    } catch { /* 平台表无此模块时用文字符号兜底 */ }

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

    // ---- 管理路由 base 探测：优先 /api/solmirror/*（宿主认证通道，新宿主），
    // 探测失败回退 /plugins/solmirror/*（老宿主直挂通道）。结果缓存。 ----
    let adminBase = null
    const resolveAdminBase = async () => {
      if (adminBase) return adminBase
      try {
        const probe = await fetch('/api/solmirror/status', { cache: 'no-store' })
        if (probe.ok) return (adminBase = '/api/solmirror')
      } catch { /* 老宿主无此路由 */ }
      return (adminBase = '/plugins/solmirror')
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

      // 保存只保存，不主动触发连接：验证走「测试连接」；常驻连接由宿主侧
      // 10s 漂移对账自动换用新密钥/新地址。
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
        const result = await ops.post(`${await resolveAdminBase()}/test`)
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


    // ---- 会话媒体面：挂在回合尾部 turnTail（对话主流、不随工具行折叠）----
    // dsh 工具行在回合结束后会被折叠收起，媒体放里面看不见；「生成中占位框 +
    // 完成的视频/图片」挂在 turnTail 永远展开，工具行只留一行状态回执。
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
      // 媒体放大层：关闭钮放媒体盒内部 hover 显示——
      // 旧版贴 stage 顶边定位，桌面端与窗口按钮/标题栏打架（--dsh-frame-chrome-top
      // 变量在部分客户端解析不到时 stage 贴顶，按钮一半压进标题栏区）。盒内定位与
      // 窗口 chrome 完全解耦；图片另支持滚轮缩放。变量取宿主设计令牌、缺宿主时
      // 退化为通用值（stage 的 chrome-top fallback=40px 保证标题栏下留白）
      '.solmirror-ov-backdrop { position: fixed; inset: 0; z-index: 1000; }',
      '.solmirror-ov-stage { position: absolute; inset: var(--dsh-frame-chrome-top, 40px) 0 0;',
      '  display: flex; align-items: center; justify-content: center; padding: 32px; }',
      '.solmirror-ov-mask { position: absolute; inset: 0;',
      '  background: var(--dsh-alias-bg-mask-1, rgba(0,0,0,0.72));',
      '  backdrop-filter: var(--dsw-mask-blur, blur(8px)); }',
      '.solmirror-ov-frame { position: relative; display: inline-flex; }',
      '.solmirror-ov-box { position: relative; display: inline-flex; overflow: hidden;',
      '  border-radius: var(--dsw-radius-lg, 10px); background: rgba(0,0,0,0.45);',
      '  box-shadow: var(--dsw-elevation-prominent, 0 12px 48px rgba(0,0,0,0.5)); }',
      // 媒体尺寸用视口单位直接自限——百分比链（max-height:100%）在 shrink-wrap
      // 盒内解析不到（首版盒包装因此把图压小/裁剪）。右侧预留 120px（关钮外挂
      // 不遮图）、底部预留 108px（工具条下沉不遮图）；chrome-top fallback 40px
      '.solmirror-ov-media { display: block;',
      '  max-width: min(calc(100vw - 120px), 1600px);',
      '  max-height: calc(100vh - var(--dsh-frame-chrome-top, 40px) - 108px);',
      '  object-fit: contain; transform-origin: center center; will-change: transform; }',
      // 关闭钮：白色，平移到图片右外侧（挂不裁剪的 frame 上，box 的
      // overflow:hidden 裁不到它），hover 显示
      '.solmirror-ov-close { position: absolute; top: 0; right: -46px; z-index: 2;',
      '  display: grid; place-items: center; width: 34px; height: 34px; border: 0;',
      '  border-radius: 999px; background: #fff; color: #1f2128;',
      '  box-shadow: 0 2px 10px rgba(0,0,0,0.35); cursor: pointer;',
      '  opacity: 0; transition: opacity 0.15s; }',
      '.solmirror-ov-frame:hover .solmirror-ov-close,',
      '.solmirror-ov-close:focus-visible { opacity: 1; }',
      // 缩放工具条（图片）：左下角下沉 hover 显示；白色系；百分比实时反映缩放状态
      '.solmirror-ov-tools { position: absolute; left: 16px; bottom: 10px; z-index: 2;',
      '  display: flex; align-items: center; gap: 6px; opacity: 0; transition: opacity 0.15s; }',
      '.solmirror-ov-backdrop:hover .solmirror-ov-tools { opacity: 1; }',
      '.solmirror-ov-tools button { display: grid; place-items: center; width: 30px; height: 30px;',
      '  border: 0; border-radius: 999px; background: #fff; color: #1f2128;',
      '  box-shadow: 0 2px 10px rgba(0,0,0,0.35); cursor: pointer; font-size: 16px; line-height: 1; }',
      '.solmirror-ov-scale { min-width: 52px; text-align: center; font-size: 12px; color: #1f2128;',
      '  background: #fff; border-radius: 999px; padding: 7px 10px;',
      '  box-shadow: 0 2px 10px rgba(0,0,0,0.35); font-variant-numeric: tabular-nums; }',
      // 出图墙（0.14.3）：单张=大图、多张=平铺网格；hover 微浮起提示可点，
      // 点击开应用内放大层（尺寸按张数在 JS 内联给出）
      '.solmirror-thumbs { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 2px; }',
      '.solmirror-thumb { display: block; padding: 0; border: 0; background: transparent;',
      '  cursor: zoom-in; border-radius: 10px; }',
      '.solmirror-thumb img { display: block; border-radius: 10px;',
      '  transition: transform 0.15s ease, box-shadow 0.15s ease; }',
      '.solmirror-thumb:hover img { transform: translateY(-2px);',
      '  box-shadow: 0 8px 22px rgba(0,0,0,0.28); }',
      // 内联视频右上角的放大钮
      '.solmirror-video-box { position: relative; width: fit-content; max-width: 100%; }',
      '.solmirror-zoom { position: absolute; top: 8px; right: 8px; z-index: 1; display: grid;',
      '  place-items: center; width: 30px; height: 30px; border: 0; border-radius: 999px;',
      '  background: rgba(0,0,0,0.45); color: #fff; cursor: zoom-in; opacity: 0; transition: opacity 0.15s; }',
      '.solmirror-video-box:hover .solmirror-zoom, .solmirror-zoom:focus-visible { opacity: 1; }',
    ].join('\n')
    document.head.append(styleTag)

    function statusTextOf(status) {
      // 服务端返回小写状态（'generating'/'pending'）
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

    // 终态结果短期缓存：页面重进/历史气泡回看时同 id 媒体卡直接用缓存渲染、
    // 零请求（临时地址有效期远大于 TTL）
    const terminalCache = new Map()
    const TERMINAL_CACHE_TTL = 5 * 60 * 1000

    function cachedTerminal(generationId) {
      const hit = terminalCache.get(generationId)
      return hit && Date.now() - hit.at < TERMINAL_CACHE_TTL ? hit.data : null
    }

    function generationIdOf(media, resultText) {
      if (!resultText) return null
      // 对外任务ID为 UUID（服务端 2026-11-09 起）——必须先于数字匹配，
      // 否则 UUID 前导数字段会被旧正则截成错误短 id；数字匹配仅为历史会话兼容
      const byUuidText = /generation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(resultText)
      if (byUuidText) return byUuidText[1]
      if (media === 'image') {
        const byUuidJson = /"generation_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(resultText)
        if (byUuidJson) return byUuidJson[1]
      }
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

    // ---- 气泡正文与结果卡片去重（0.14.3）----
    // agent 常把 get_media_url 的地址用 ![](url) 贴进正文（宿主渲染成大图），
    // 结果卡片再出一张小图=同一张图看两遍。地址每次现签（query 变），但 URL
    // 路径恒定且与卡片地址同源同 signer——按路径精确对上即视为「已在正文展示」，
    // 卡片侧跳过该图，全部命中时收敛成一行回执。
    const EMPTY_PATHS = new Set()

    function pathOf(url) {
      return String(url).split(/[?#]/)[0]
    }

    // markdown 图片语法 + <img> 标签两种内嵌形态都认（后者个别模型爱用）
    const INLINE_IMG_RE = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\s*\)|<img[^>]*\ssrc=["'](https?:\/\/[^"']+)["']/gi

    function collectInlineImagePaths(turnNodes) {
      const paths = new Set()
      for (const node of turnNodes) {
        // assistant-step 相：data.blocks=AssistantBlock[]（kind:'text' 带正文）
        const blocks = Array.isArray(node?.data?.blocks) ? node.data.blocks : []
        for (const block of blocks) {
          if (block?.kind !== 'text' || !block.text) continue
          for (const match of String(block.text).matchAll(INLINE_IMG_RE)) {
            const url = match[1] ?? match[2]
            if (url) paths.add(pathOf(url))
          }
        }
      }
      return paths
    }

    // callId→generationId 映射（宿主半边私有路由）：新会话的媒体面靠这张表
    // 反查；旧会话文本里本就有 id，regex 兜底。
    const callsCache = { at: 0, data: {} }
    async function loadCalls() {
      if (Date.now() - callsCache.at < 30_000) return callsCache.data
      try {
        const response = await fetch(`${await resolveAdminBase()}/calls`, { cache: 'no-store' })
        const data = await response.json()
        if (data && data.ok && data.calls && typeof data.calls === 'object') {
          callsCache.at = Date.now()
          callsCache.data = data.calls
        }
      } catch { /* 映射不可用时旧文本 regex 兜底 */ }
      return callsCache.data
    }

    /** 占位框：跟随生成比例的空白框 + 扫光动效 + 生成中文案。
     *  small=true 为网格内贴片尺寸（与出图墙缩略图同量级，0.14.6）。
     *  工厂式调用（非组件），key 需随参数透传给根元素。 */
    function Placeholder({ key, aspect, sub, small }) {
      const ratio = aspect ?? { w: 16, h: 9 }
      const portrait = ratio.h > ratio.w
      const capW = small ? 240 : 420
      const capH = small ? 300 : 360
      const style = portrait
        ? { height: `${capH}px`, width: 'auto', aspectRatio: `${ratio.w} / ${ratio.h}`, maxWidth: '100%' }
        : { width: '100%', maxWidth: `${capW}px`, aspectRatio: `${ratio.w} / ${ratio.h}` }
      return React.createElement('div', { key, className: 'solmirror-ph', style },
        React.createElement('div', { className: 'solmirror-ph-sweep' }),
        React.createElement('div', { className: 'solmirror-ph-face' },
          React.createElement('div', { className: 'solmirror-ph-title' }, '生成中'),
          sub ? React.createElement('div', { className: 'solmirror-ph-sub' }, sub) : null),
      )
    }

    /** 应用内媒体放大层（自绘）：portal 到 body 的全屏遮罩，Esc 或点遮罩或关闭钮关；
     *  视频自动播放并带控制条；图片支持滚轮缩放（中心锚点，1~10 倍，滚轮作用整个
     *  遮罩层——鼠标在图上/遮罩上都能缩）、放大后拖拽平移、双击在 1x/2.5x 间切换；
     *  关闭钮在媒体盒内部右上角，hover 显示。 */
    function MediaOverlay({ url, kind, onClose }) {
      const [zoom, setZoom] = React.useState({ s: 1, x: 0, y: 0 })
      const backdropRef = React.useRef(null)
      const mediaRef = React.useRef(null)
      const dragRef = React.useRef(null)

      React.useEffect(() => {
        const onKeyDown = event => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      // 缩放统一入口：倍率钳制 1~10，平移钳制在媒体边界内
      const nudgeZoom = factor => setZoom(prev => {
        const s = Math.min(10, Math.max(1, prev.s * factor))
        const img = mediaRef.current
        const maxX = ((img?.offsetWidth ?? 0) * (s - 1)) / 2
        const maxY = ((img?.offsetHeight ?? 0) * (s - 1)) / 2
        return {
          s,
          x: Math.max(-maxX, Math.min(maxX, prev.x)),
          y: Math.max(-maxY, Math.min(maxY, prev.y)),
        }
      })

      // 图片滚轮缩放：window 捕获阶段拦截（先于宿主任何捕获/冒泡监听，防滚动劫持），
      // 仅当事件目标在本遮罩层内才消费；原生非 passive 才能 preventDefault
      React.useEffect(() => {
        if (kind !== 'image') return undefined
        const onWheel = event => {
          const root = backdropRef.current
          if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return
          event.preventDefault()
          event.stopPropagation()
          nudgeZoom(event.deltaY < 0 ? 1.2 : 1 / 1.2)
        }
        window.addEventListener('wheel', onWheel, { capture: true, passive: false })
        return () => window.removeEventListener('wheel', onWheel, { capture: true })
      }, [kind])

      // 缩回 1x 时平移复位
      React.useEffect(() => {
        if (zoom.s === 1 && (zoom.x !== 0 || zoom.y !== 0)) setZoom({ s: 1, x: 0, y: 0 })
      }, [zoom])

      const isImage = kind === 'image'
      const media = isImage
        ? React.createElement('img', {
            ref: mediaRef, className: 'solmirror-ov-media', src: url, alt: '媒体预览',
            draggable: false, style: {
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
              cursor: zoom.s > 1 ? 'grab' : 'default',
              userSelect: 'none',
            },
            onDoubleClick: () => setZoom(prev => (prev.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 })),
            onPointerDown: event => {
              if (zoom.s <= 1) return
              event.preventDefault()
              dragRef.current = { px: event.clientX, py: event.clientY, x: zoom.x, y: zoom.y, id: event.pointerId }
              event.currentTarget.setPointerCapture(event.pointerId)
            },
            onPointerMove: event => {
              const d = dragRef.current
              const el = mediaRef.current
              if (!d || !el || d.id !== event.pointerId) return
              const maxX = (el.offsetWidth * (zoom.s - 1)) / 2
              const maxY = (el.offsetHeight * (zoom.s - 1)) / 2
              setZoom(prev => ({
                s: prev.s,
                x: Math.max(-maxX, Math.min(maxX, d.x + event.clientX - d.px)),
                y: Math.max(-maxY, Math.min(maxY, d.y + event.clientY - d.py)),
              }))
            },
            onPointerUp: () => { dragRef.current = null },
            onPointerCancel: () => { dragRef.current = null },
          })
        : React.createElement('video', {
            ref: mediaRef, className: 'solmirror-ov-media', src: url, controls: true,
            autoPlay: true, playsInline: true, preload: 'metadata', style: { background: '#000' },
          })
      return ReactDOM.createPortal(
        React.createElement('div', {
          ref: backdropRef, className: 'solmirror-ov-backdrop', role: 'dialog', 'aria-modal': 'true',
        },
          React.createElement('div', { className: 'solmirror-ov-stage' },
            React.createElement('div', { className: 'solmirror-ov-mask', 'aria-hidden': 'true', onMouseDown: onClose }),
            React.createElement('div', { className: 'solmirror-ov-frame' },
              React.createElement('div', { className: 'solmirror-ov-box' }, media),
              React.createElement('button', {
                type: 'button', className: 'solmirror-ov-close', 'aria-label': '关闭预览', onClick: onClose,
              }, IconClose ? React.createElement(IconClose, { size: 15 }) : '×'))),
          isImage
            ? React.createElement('div', { className: 'solmirror-ov-tools' },
                React.createElement('button', {
                  type: 'button', 'aria-label': '缩小', onClick: () => nudgeZoom(0.8),
                }, '−'),
                React.createElement('span', { className: 'solmirror-ov-scale' }, `${Math.round(zoom.s * 100)}%`),
                React.createElement('button', {
                  type: 'button', 'aria-label': '放大', onClick: () => nudgeZoom(1.25),
                }, '+'),
                zoom.s > 1
                  ? React.createElement('button', {
                      type: 'button', 'aria-label': '复位', title: '复位',
                      onClick: () => setZoom({ s: 1, x: 0, y: 0 }),
                    }, '⤢')
                  : null)
            : null),
        document.body)
    }

    /** 单个生成的媒体卡：轮询本地路由，占位 → 播放器/图片/错误。
     *  inlineImagePaths=本回合 assistant 正文里已内嵌的图 URL 路径集合——
     *  命中的图不再出缩略图（去重，0.14.3）。 */
    function MediaCard({ gen, inlineImagePaths }) {
      const [info, setInfo] = React.useState(() => cachedTerminal(gen.generationId))
      const [netError, setNetError] = React.useState('')
      // 应用内放大预览目标：null | { url, kind: 'image' | 'video' }
      const [lightbox, setLightbox] = React.useState(null)
      const inlineVideoRef = React.useRef(null)
      const generationId = gen.generationId

      React.useEffect(() => {
        if (!generationId) return undefined
        // 缓存命中的终态：零请求。id 经 calls 反查比首渲染晚一拍，初始化器可能
        // 已在 id=null 时跑过——须先播种缓存再停轮询，否则卡片停在占位框
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
            const response = await fetch(`${await resolveAdminBase()}/generation?id=${encodeURIComponent(generationId)}`, { cache: 'no-store' })
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
          // 轮询失败指数退避（5s→60s 封顶）无限重试，服务恢复后回到 5s 节奏
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
        // 从未拿到状态且轮询失败中 → 副文案明示在自动重试
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
      // 与气泡正文重复的图（agent 已用 markdown 内嵌过同路径地址）不再出缩略图
      const inline = inlineImagePaths ?? EMPTY_PATHS
      const shownUrls = urls.filter(url => !inline.has(pathOf(url)))
      const dupCount = urls.length - shownUrls.length
      const children = [
        React.createElement('div', { key: 'head', style: MS.head },
          React.createElement('span', { style: MS.title }, label),
          React.createElement('span', { style: MS.ok }, '已生成'),
          !isVideo && urls.length > 1
            ? React.createElement('span', { style: MS.tag }, `${urls.length} 张`)
            : null),
      ]
      if (isVideo) {
        const url = urls[0] || (info && info.url) || ''
        if (url) {
          // 内联小窗可播；悬停浮出放大钮 → 应用内大窗自动播放（不跳浏览器）
          children.push(React.createElement('div', { key: 'video', className: 'solmirror-video-box' },
            React.createElement('video', {
              ref: inlineVideoRef, controls: true, preload: 'metadata', src: url, style: MS.video,
            }),
            React.createElement('button', {
              type: 'button', className: 'solmirror-zoom', 'aria-label': '放大播放', title: '放大播放',
              onClick: () => {
                if (inlineVideoRef.current) inlineVideoRef.current.pause()
                setLightbox({ url, kind: 'video' })
              },
            }, IconFullscreen ? React.createElement(IconFullscreen, { size: 15 }) : '⤢')))
          if (info.summary) children.push(React.createElement('div', { key: 'summary', style: MS.muted }, info.summary))
          children.push(React.createElement('a', { key: 'open', href: url, target: '_blank', rel: 'noreferrer', style: MS.link }, '在新标签页打开'))
        }
      } else if (shownUrls.length) {
        // 出图墙（0.14.3）：单张=大图、多张=平铺网格；点击开应用内放大层
        const single = shownUrls.length === 1
        const thumbImgStyle = single
          ? { maxWidth: '480px', maxHeight: '540px' }
          : { maxWidth: '300px', maxHeight: '380px' }
        children.push(React.createElement('div', { key: 'imgs', className: 'solmirror-thumbs' },
          shownUrls.map((url, index) => React.createElement('button', {
            key: index, type: 'button', className: 'solmirror-thumb',
            'aria-label': `放大查看生成图 ${index + 1}`,
            onClick: () => setLightbox({ url, kind: 'image' }),
          },
          React.createElement('img', {
            src: url, alt: `生成图 ${index + 1}`, loading: 'lazy', style: thumbImgStyle,
          })))))
        if (dupCount) {
          children.push(React.createElement('div', { key: 'dup', style: MS.muted },
            `另有 ${dupCount} 张已在上方消息中展示`))
        }
        if (info.summary) children.push(React.createElement('div', { key: 'summary', style: MS.muted }, info.summary))
      } else if (dupCount) {
        // 全部图都已在正文里展示：卡片收敛成回执，不再重复出图
        children.push(React.createElement('div', { key: 'dup', style: MS.muted },
          `${urls.length} 张生成图已在上方消息中展示`))
        if (info.summary) children.push(React.createElement('div', { key: 'summary', style: MS.muted }, info.summary))
      }
      if (netError) children.push(React.createElement('div', { key: 'net', style: MS.muted }, `状态刷新失败：${netError}`))
      // 放大预览挂卡尾：统一自绘放大层（不用宿主 ImageLightbox——其关闭钮
      // 贴 stage 顶边定位，在桌面端与窗口按钮打架，且无滚轮缩放）
      if (lightbox) {
        const close = () => setLightbox(null)
        children.push(React.createElement(MediaOverlay, {
          key: 'lightbox', url: lightbox.url, kind: lightbox.kind, onClose: close,
        }))
      }
      return React.createElement('div', { style: MS.wrap }, ...children)
    }

    /** 多生成聚合轮询 hook（0.14.4 合并墙用）：一次 effect 管多个 generationId，
     *  逐 id 轮询/缓存播种/指数退避/终态停表——口径与单卡 MediaCard 一致
     *  （含 0.10.4 的「id 晚到先播种缓存再停表」教训）。 */
    function useTerminalInfos(genIds) {
      const key = genIds.join('|')
      const [state, setState] = React.useState(() => {
        const infos = {}
        for (const id of genIds) {
          const cached = cachedTerminal(id)
          if (cached) infos[id] = cached
        }
        return { infos, netError: '' }
      })
      React.useEffect(() => {
        let stopped = false
        const timers = new Set()
        const failures = new Map()
        // 缓存播种：id 比首渲染晚一拍（calls 反查）时补种，否则卡片停在占位框
        setState(prev => {
          let changed = false
          const seed = {}
          for (const id of genIds) {
            const cached = cachedTerminal(id)
            if (cached && !prev.infos[id]) { seed[id] = cached; changed = true }
          }
          return changed ? { ...prev, infos: { ...prev.infos, ...seed } } : prev
        })
        const tick = async id => {
          let netError = ''
          try {
            const response = await fetch(`${await resolveAdminBase()}/generation?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
            const data = await response.json().catch(() => null)
            if (stopped) return
            if (data && data.ok) {
              failures.set(id, 0)
              setState(prev => ({ ...prev, netError: '', infos: { ...prev.infos, [id]: data } }))
              if (TERMINAL_STATUSES.has(String(data.status).toLowerCase())) {
                terminalCache.set(id, { at: Date.now(), data })
                return
              }
            } else {
              failures.set(id, (failures.get(id) ?? 0) + 1)
              netError = (data && data.message) || `HTTP ${response.status}`
            }
          } catch (error) {
            if (stopped) return
            failures.set(id, (failures.get(id) ?? 0) + 1)
            netError = String((error && error.message) || error)
          }
          if (stopped) return
          if (netError) setState(prev => (prev.netError === netError ? prev : { ...prev, netError }))
          const failureCount = failures.get(id) ?? 0
          const timer = setTimeout(() => { timers.delete(timer); void tick(id) },
            failureCount === 0 ? 5000 : Math.min(5000 * 2 ** failureCount, 60000))
          timers.add(timer)
        }
        for (const id of genIds) {
          if (cachedTerminal(id)) continue // 终态缓存命中=零请求
          void tick(id)
        }
        return () => { stopped = true; for (const timer of timers) clearTimeout(timer) }
      }, [key])
      return state
    }

    /** 回合内图片生成合并墙（0.14.4）：多次 generate_image 不再各带一条
     *  「图片生成 已生成」标题，收敛成一个区域——汇总头（已生成 X 张·生成中 Y·
     *  Z 失败）+ 小图网格 + 聚合摘要（总张数/总积分/去重提示）；只有一张时
     *  仍出大图。去重口径与单卡一致（正文已内嵌的同路径图跳过）。 */
    function ImageStackCard({ gens, inlineImagePaths }) {
      const inline = inlineImagePaths ?? EMPTY_PATHS
      const genIds = gens.map(gen => gen.generationId).filter(Boolean)
      const { infos, netError } = useTerminalInfos(genIds)
      const [lightbox, setLightbox] = React.useState(null)

      let shownUrls = []
      let dupCount = 0
      let pending = 0
      let pendingAspect = null
      let failed = 0
      let failedMsg = ''
      let points = 0
      let pointsKnown = false
      let totalImages = 0
      for (const gen of gens) {
        if (gen.error) {
          failed += 1
          if (!failedMsg) failedMsg = gen.error
          continue
        }
        if (!gen.generationId) {
          pending += 1
          pendingAspect = pendingAspect ?? gen.aspect
          continue
        }
        const info = infos[gen.generationId]
        if (!info) {
          pending += 1
          pendingAspect = pendingAspect ?? gen.aspect
          continue
        }
        const status = String(info.status).toLowerCase()
        if (!TERMINAL_STATUSES.has(status)) {
          pending += 1
          pendingAspect = pendingAspect ?? gen.aspect
          continue
        }
        if (status !== 'succeeded') {
          failed += 1
          if (!failedMsg && info.error) failedMsg = info.error
          continue
        }
        const urls = (Array.isArray(info.urls) ? info.urls : []).map(String).filter(Boolean)
        totalImages += urls.length
        for (const url of urls) {
          if (inline.has(pathOf(url))) dupCount += 1
          else shownUrls.push(url)
        }
        if (info.points !== null && info.points !== undefined && Number.isFinite(Number(info.points))) {
          points += Number(info.points)
          pointsKnown = true
        }
      }

      const headParts = [React.createElement('span', { key: 'label', style: MS.title }, '图片生成')]
      if (totalImages > 0) {
        headParts.push(React.createElement('span', { key: 'ok', style: MS.ok }, `已生成 ${totalImages} 张`))
      }
      if (pending > 0) {
        headParts.push(React.createElement('span', { key: 'run', style: MS.muted }, `生成中 ${pending}`))
      }
      if (failed > 0) {
        headParts.push(React.createElement('span', { key: 'fail', style: MS.err }, `${failed} 个失败`))
      }
      const children = [React.createElement('div', { key: 'head', style: MS.head }, ...headParts)]

      if (pending > 0 && shownUrls.length === 0 && dupCount === 0) {
        // 全部在途：一个占位框即可（多张时文案报数）
        children.push(React.createElement('div', { key: 'ph', style: MS.wrap },
          Placeholder({ aspect: pendingAspect, sub: pending > 1 ? `生成中 ${pending} 张` : undefined })))
      }
      if (shownUrls.length || pending > 0) {
        // 已有出图 + 还有在途：占位以小贴片进网格末尾（0.14.6——修「墙里有图
        // 就看不到生成中占位」）；全部在途时上面已出整框，不重复
        const single = shownUrls.length === 1 && pending === 0
        const thumbImgStyle = single
          ? { maxWidth: '480px', maxHeight: '540px' }
          : { maxWidth: '240px', maxHeight: '300px' }
        const tiles = shownUrls.map((url, index) => React.createElement('button', {
          key: index, type: 'button', className: 'solmirror-thumb',
          'aria-label': `放大查看生成图 ${index + 1}`,
          onClick: () => setLightbox({ url, kind: 'image' }),
        },
        React.createElement('img', {
          src: url, alt: `生成图 ${index + 1}`, loading: 'lazy', style: thumbImgStyle,
        })))
        if (pending > 0 && shownUrls.length > 0) {
          tiles.push(Placeholder({
            key: 'pending-tile', aspect: pendingAspect,
            sub: pending > 1 ? `还有 ${pending} 张` : undefined, small: true,
          }))
        }
        children.push(React.createElement('div', { key: 'imgs', className: 'solmirror-thumbs' }, ...tiles))
      } else if (dupCount > 0 && pending === 0) {
        children.push(React.createElement('div', { key: 'dup', style: MS.muted },
          `${dupCount} 张生成图已在上方消息中展示`))
      }
      // 聚合摘要：总张数 + 总积分 + 去重提示（多图才有信息量；单张积分照旧给）
      const footParts = []
      if (dupCount > 0 && shownUrls.length > 0) footParts.push(`另有 ${dupCount} 张已在上方消息中展示`)
      if (pointsKnown) footParts.push(`共 ${totalImages} 张 · 消耗 ${points} 积分`)
      if (footParts.length) {
        children.push(React.createElement('div', { key: 'foot', style: MS.muted }, footParts.join('，')))
      }
      if (failedMsg) {
        children.push(React.createElement('div', { key: 'failmsg', style: MS.err }, failedMsg.slice(0, 200)))
      }
      if (netError) {
        children.push(React.createElement('div', { key: 'net', style: MS.muted }, `状态刷新失败：${netError}`))
      }
      if (lightbox) {
        children.push(React.createElement(MediaOverlay, {
          key: 'lightbox', url: lightbox.url, kind: lightbox.kind, onClose: () => setLightbox(null),
        }))
      }
      return React.createElement('div', { style: MS.wrap }, ...children)
    }

    /** 从会话快照收集本回合的 solmirror 生成（含运行中与子调用）与正文内嵌图路径。 */
    function collectGenerations(snapshot, turnNumber, callsMap) {
      const found = []
      const seen = new Set()
      const visit = block => {
        if (!block || typeof block !== 'object') return
        const subCalls = Array.isArray(block.subCalls) ? block.subCalls : []
        for (const child of subCalls) visit(child)
        // ToolCallBlock 三态：ToolResultNode 用 kind:'tool-result' 标记（无 phase
        // 字段），Preparing/Started 才有 phase；结果相名字按 call.name 优先解析
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
          // 提交就失败的调用没有 generationId：渲染一行失败回执，不占位框
          // （避免误当"还有一个在生成"）
          error: isResult && block.isError ? textOf(block) : '',
          // 新会话文本无 id → 私有映射反查；旧会话/降级路径文本带 id → regex
          // generationId 为 UUID 字符串（服务端 2026-11-09 起）或旧数字 id
          generationId: generationIdOf(media, resultText)
            ?? (mapped?.generationId ?? null),
          aspect: parseAspect(argsRaw) ?? ratioOf(mapped?.aspect),
        })
      }
      const turnNodes = []
      try {
        const keys = snapshot?.locations?.getTurn?.(turnNumber) ?? []
        for (const key of keys) {
          const node = snapshot?.nodes?.get?.(key)
          if (!node) continue
          turnNodes.push(node)
          if (node.kind !== 'tool-call') continue
          visit(node?.data?.root)
        }
      } catch { /* 快照结构异常时静默不渲染 */ }
      return { gens: found, inlineImagePaths: collectInlineImagePaths(turnNodes) }
    }

    /** 回合尾部的媒体面：图片生成全部合并进一个区域（ImageStackCard，0.14.4），
     *  视频仍一卡一播放器；正文已内嵌的图路径全链去重。 */
    function SolmirrorTurnTail(props) {
      const turnNumber = props?.turn?.turn
      const [calls, setCalls] = React.useState(null)
      const collected = typeof props.useChat === 'function'
        ? props.useChat(snapshot => collectGenerations(snapshot, turnNumber, calls))
        : collectGenerations(null, turnNumber, calls)
      const gens = collected?.gens ?? []
      React.useEffect(() => {
        if (!gens || gens.length === 0) return undefined
        if (gens.every(gen => gen.generationId)) return undefined
        let stopped = false
        // id 反查定时重试直到本回合全部解析（loadCalls 自带 30s TTL）；
        // 全部解析后本 effect 重建即清掉 interval。
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
      // 回合收编（0.14.6 闸②）：尾部挂载=本回合已收尾，把这些生成从工具行共享墙
      // 释放（尾部墙接管展示）——新回合从空墙开始，旧回合行不再污染新回合的墙。
      // 合成兜底 callId（`mcp__solmirror__generate_*-N`）与真实行 callId 对不上，
      // 跳过即可。
      React.useEffect(() => {
        const callIds = (gens ?? [])
          .map(gen => gen.callId)
          .filter(id => id && !id.startsWith('mcp__solmirror__generate_'))
        toolWallRelease(callIds)
      }, [gens])
      if (!gens || gens.length === 0) return null
      // 图片并进一个合并墙（挂在首个图片生成的位置）；视频逐卡
      const inlineImagePaths = collected?.inlineImagePaths
      const imageGens = gens.filter(gen => gen.media === 'image')
      const children = []
      let stackPlaced = false
      for (const gen of gens) {
        if (gen.media === 'video') {
          children.push(React.createElement(MediaCard, { key: gen.callId, gen, inlineImagePaths }))
          continue
        }
        if (!stackPlaced) {
          children.push(React.createElement(ImageStackCard, { key: 'imgstack', gens: imageGens, inlineImagePaths }))
          stackPlaced = true
        }
      }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, ...children)
    }

    /** 工具行视图：turn-tail 节点只在回合结束时发布，活跃回合里回合尾部不存在，
     *  这段窗口的媒体面挂工具行（toolview 键控替换整行）：视频=进行中跟随比例
     *  占位框、结果相一行回执（尾部卡轮询接管）；图片=全部并进共享合并墙
     *  （ImageToolRow，见 toolWall 注释）。回合收尾后工具行折叠、回合尾部的
     *  媒体面接管。id 不上 UI。 */
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
        // 结果相文本带 id → 行内媒体卡；无 id（新式视频文本）→ 一行回执
        //（尾部卡有映射反查全通道，接管展示）
        if (gen.generationId) return React.createElement(MediaCard, { gen })
        return React.createElement('div', { style: MS.rowLine },
          React.createElement('span', null, label, ' · 已提交'))
      }
    }

    // ---- 图片工具行共享墙（0.14.5；0.14.6/0.14.7 修跨回合累积与误杀；0.14.8 补回执）----
    // 宿主 toolview owner props 只有 callId/toolName/phase/block/…（实测
    // ToolCallTree：无 useChat、无 turn），跨行合并拿不到回合快照——插件侧自建
    // 注册表：每个图片工具行把自己的生成登记进来，只有「最新一条」行渲染合并墙，
    // 其余行出单行回执（0.14.8：调用记录必须在，图才不重复）；行卸载即注销并
    // 重选宿主行。回合收尾工具行折叠、回合尾部的 ImageStackCard 接管。
    // 回放判别（0.14.7 重写；0.14.6 的「首见相位≠result」闸是错的——MCP 调用
    // 先返回 generation_id、生成仍在服务端跑时，**活跃行就以 result 相位首挂**，
    // 被误判回放导致工具气泡全空白）。新判据三道：
    // ①首见相位≠result（preparing/start）= 活跃铁证（回放块永远是 result）；
    // ②首见即 result 的行，问宿主半边 /calls 的 live 名单（宿主在 MCP 真执行时
    //   记录本会话 callId，30 分钟滚动）——在名单=活跃，不在=历史回放；
    // ③回合尾部挂载即释放本回合 callIds 并**永久拉黑**（released 集合）——回合
    //   结束后展示归尾部，滚动重挂/同会话回放一律不再入墙（回执仍出）。
    const toolWall = { gens: [], released: new Set(), listeners: new Set(), version: 0 }
    let toolWallSeq = 0

    function toolWallSubscribe(listener) {
      toolWall.listeners.add(listener)
      return () => { toolWall.listeners.delete(listener) }
    }

    function toolWallSnapshot() {
      return toolWall.version
    }

    function toolWallEmit() {
      toolWall.version += 1
      for (const listener of toolWall.listeners) listener()
    }

    function sameGen(a, b) {
      return a.media === b.media
        && a.generationId === b.generationId
        && a.error === b.error
        && a.aspect?.w === b.aspect?.w
        && a.aspect?.h === b.aspect?.h
    }

    function toolWallRegister(gen) {
      if (toolWall.released.has(gen.callId)) return
      const index = toolWall.gens.findIndex(item => item.callId === gen.callId)
      if (index >= 0) {
        if (sameGen(toolWall.gens[index], gen)) return // 无变化不广播，防渲染环
        toolWall.gens[index] = gen
      } else {
        toolWall.gens.push(gen)
      }
      toolWallEmit()
    }

    function toolWallUnregister(callId) {
      const before = toolWall.gens.length
      toolWall.gens = toolWall.gens.filter(item => item.callId !== callId)
      if (toolWall.gens.length !== before) toolWallEmit()
    }

    /** 回合收编：尾部接管展示后，把这些 callId 从共享墙释放并永久拉黑。 */
    function toolWallRelease(callIds) {
      if (!Array.isArray(callIds) || callIds.length === 0) return
      let changed = false
      for (const callId of callIds) {
        if (toolWall.released.has(callId)) continue
        toolWall.released.add(callId)
        changed = true
      }
      const before = toolWall.gens.length
      toolWall.gens = toolWall.gens.filter(item => !toolWall.released.has(item.callId))
      if (changed || toolWall.gens.length !== before) toolWallEmit()
    }

    // 活跃调用核验缓存（callId→boolean）：宿主半边 /calls 回包的 live 名单是
    // 真相源；每个 callId 会话内只核验一次，核验期间共享一个在途请求。
    const liveProbeCache = new Map()
    let liveProbeInflight = null

    function probeLiveCallId(callId) {
      if (liveProbeCache.has(callId)) return Promise.resolve(liveProbeCache.get(callId))
      if (!liveProbeInflight) {
        liveProbeInflight = resolveAdminBase().then(base => fetch(`${base}/calls`, { cache: 'no-store' }))
          .then(response => response.json())
          .then(data => {
            const live = new Set(Array.isArray(data?.live) ? data.live.map(String) : [])
            liveProbeInflight = null
            return live
          })
          .catch(() => { liveProbeInflight = null; return new Set() })
      }
      return liveProbeInflight.then(live => {
        const verdict = live.has(callId)
        liveProbeCache.set(callId, verdict)
        return verdict
      })
    }

    /** 图片工具行的单行回执（0.14.8）：非宿主行/已释放行/回放行不再隐形——
     *  工具气泡「已调用工具」展开后每次调用都留一条「图片生成 · 状态」记录
     *  （图不重复展示，调用记录必须留痕）。状态经 /generation
     *  轮询（terminalCache 与尾部墙共享，历史回放大多零请求）。 */
    function ImageRowReceipt({ gen }) {
      const singleId = gen.generationId ? [gen.generationId] : []
      const { infos } = useTerminalInfos(singleId)
      const info = gen.generationId ? infos[gen.generationId] : null
      let label = '生成中'
      let error = gen.error || ''
      let okCount = 0
      if (gen.error) {
        label = '提交失败'
      } else if (!gen.generationId) {
        label = '已提交'
      } else if (info) {
        const status = String(info.status).toLowerCase()
        if (status === 'succeeded') {
          label = '已生成'
          okCount = Array.isArray(info.urls) ? info.urls.length : 0
        } else if (status === 'failed') {
          label = '生成失败'
          if (info.error) error = info.error
        } else if (status === 'review_rejected') {
          label = '审核未通过'
        } else if (TERMINAL_STATUSES.has(status)) {
          label = statusTextOf(status)
        }
      }
      const labelStyle = label === '已生成' ? MS.ok
        : (label === '生成失败' || label === '审核未通过' || label === '提交失败') ? MS.err : {}
      return React.createElement('div', { style: MS.rowLine },
        React.createElement('span', null, '图片生成 · ',
          React.createElement('span', { style: labelStyle },
            label === '已生成' && okCount > 1 ? `已生成 ${okCount} 张` : label)),
        error ? React.createElement('span', { style: MS.err }, String(error).slice(0, 120)) : null)
    }

    /** 图片工具行：宿主行渲染合并墙；其余行（非宿主/已释放/回放）出单行回执。 */
    function ImageToolRow(props) {
      const phase = props.phase
      const block = props.block
      const isResult = phase === 'result'
      const resultText = isResult && block && !block.isError ? textOf(block) : ''
      const callId = String(props.callId ?? '') || `image-row-${++toolWallSeq}`
      const gen = {
        callId,
        media: 'image',
        generationId: generationIdOf('image', resultText),
        aspect: parseAspect(isResult ? (block && block.call && block.call.argsRaw) : (block && block.argsRaw)),
        error: isResult && block && block.isError ? textOf(block) : '',
      }
      const genRef = React.useRef(gen)
      genRef.current = gen
      // 活跃判定：null=未判定（渲染 null）/ true=活跃 / false=回放
      const [live, setLive] = React.useState(null)
      const aspectKey = gen.aspect ? `${gen.aspect.w}x${gen.aspect.h}` : ''
      React.useEffect(() => {
        if (live === null) {
          let disposed = false
          if (phase !== 'result') { setLive(true); return undefined } // 闸①起始相位
          if (toolWall.released.has(genRef.current.callId)) { setLive(false); return undefined } // 闸③
          void probeLiveCallId(genRef.current.callId).then(ok => { // 闸②宿主 live 名单
            if (!disposed) setLive(ok)
          })
          return () => { disposed = true }
        }
        if (live !== true) return undefined
        toolWallRegister(genRef.current)
        return () => toolWallUnregister(genRef.current.callId)
      }, [live, gen.callId, phase, gen.generationId, gen.error, aspectKey])
      React.useSyncExternalStore(toolWallSubscribe, toolWallSnapshot, toolWallSnapshot)
      // 宿主行=最新登记的图片行（活跃回合的新动作总在底部，墙跟着走）：出墙；
      // 其余一切行（非宿主活跃行/已释放行/回放行）出单行回执——展开「已调用
      // 工具」时每次调用都有记录（0.14.8，修 0.14.5~0.14.7 的行隐形）。
      const host = toolWall.gens[toolWall.gens.length - 1]
      if (live === true && host && host.callId === gen.callId) {
        return React.createElement(ImageStackCard, { gens: [...toolWall.gens] })
      }
      return React.createElement(ImageRowReceipt, { gen })
    }

    return {
      inject: ['slots', 'remote', 'remote.credentials', 'remote.settings'],
      apply(ctx) {
        const injected = () => ({
          async fetchStatus() {
            const response = await fetch(`${await resolveAdminBase()}/status`, { cache: 'no-store' })
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
        // 工具行=活跃回合的媒体面（占位框/出图墙）；回合收尾后随行折叠、尾部卡接管。
        // 图片行走共享合并墙（ImageToolRow）；视频保持一行回执/占位框
        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = [
            ctx.slots.register({ name: 'tool.call.toolview', key: VIDEO_TOOL }, toolRowView('video')),
            ctx.slots.register({ name: 'tool.call.toolview', key: IMAGE_TOOL }, ImageToolRow),
          ]
          return () => { for (const dispose of disposers) dispose() }
        })
      },
    }
  },
})
