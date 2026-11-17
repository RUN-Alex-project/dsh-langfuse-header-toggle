/**
 * Browser half of the "Langfuse session upload switch" bundle.
 *
 * Registers one session-scoped control into
 * `conversation.session.header.actions` — the band beside the conversation
 * title and before the header utilities. Every visible state comes from the
 * Host bridge (`/dsh-langfuse-toggle`), never from localStorage or a local
 * default:
 *
 * - on mount and on every session change it queries the exact `sessionId`;
 * - while mounted it polls (and refreshes on window focus, tab visibility, and
 *   a new Connection generation) so `/lf on|off|off-all` typed in a command
 *   bar reaches the header without a reload;
 * - a toggle click sends the explicit decision and shows the confirmed state
 *   only after the Host acknowledges it. A failed query or a failed operation
 *   renders "状态未知", and a click then retries the query instead of granting
 *   consent.
 *
 * `createAnswerGate` is the pure guard shared by every async answer: it drops
 * answers for another session, answers superseded by a newer query, and
 * answers that raced a mutation. That is what keeps a late response for
 * Session A from painting Session B as enabled.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-langfuse-header-toggle',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const createElement = React.createElement;

    /**
     * Exact authenticated Host routes, document-relative so a mount proxy
     * keeps working. Both live on DSH's shared `/api` channel, which applies the
     * Host/Origin fence and browser-cookie authentication before dispatch.
     */
    const ROUTES = Object.freeze({
      state: 'api/dsh-langfuse-toggle/state',
      set: 'api/dsh-langfuse-toggle/set',
      scan: 'api/dsh-langfuse-toggle/scan',
      migrate: 'api/dsh-langfuse-toggle/migrate',
      config: 'api/dsh-langfuse-toggle/config',
    });
    /** Client locale namespace owned by this bundle. */
    const NS = 'langfuseUpload';
    /** Background refresh cadence while the control is mounted. */
    const POLL_INTERVAL_MS = 4000;
    /** Tooltip width budget used for viewport clamping. */
    const TOOLTIP_WIDTH = 320;
    /** Upload-hook panel width budget. */
    const PANEL_WIDTH = 460;

    /**
     * POST one JSON payload to a Host route and decode its JSON answer.
     * @param {string} route - document-relative exact route.
     * @param {object} payload - JSON request body.
     * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, error }`.
     */
    async function postJson(route, payload) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403) throw new Error('unauthorized');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('malformed response');
      return body;
    }

    const ZH = {
      'label.title': '本会话上传',
      'label.titleShort': '上传',
      'state.on': '开',
      'state.off': '关',
      'state.loading': '查询中',
      'state.saving': '处理中',
      'state.unknown': '状态未知',
      'details.aria': '查看本会话上传说明（不会切换开关）',
      'label.on': '本会话上传：开',
      'label.off': '本会话上传：关',
      'label.loading': '本会话上传：查询中',
      'label.saving': '本会话上传：处理中',
      'label.unknown': '本会话上传：状态未知',
      'label.onShort': '会话上传：开',
      'label.offShort': '会话上传：关',
      'label.loadingShort': '会话上传：查询中',
      'label.savingShort': '会话上传：处理中',
      'label.unknownShort': '会话上传：状态未知',
      'aria.switch': '本会话上传到团队 Langfuse',
      'aria.unknown': '本会话上传到团队 Langfuse，状态未知，按下重新查询',
      hint: '开启后，本会话新开始的轮次（提问、回答、工具调用等）会上传到团队 Langfuse；已上传内容无法撤回。',
      scope: '仅对当前会话生效；/lf 命令与开关同一状态。点击左侧名称查看说明，右侧开关才是切换。',
      receipt: '「开」表示已授权，不代表每次上传都发送成功；可用 /lf status 查看发送结果。',
      sendStats: '本次进程已确认接收：{sent} 轮；失败：{failed} 轮。',
      lastError: '最近一次发送未完成：{error}',
      retry: '点击按钮重新查询后台状态（不会自动重试授权操作）。',
      'error.uploader': '上传插件尚未就绪。',
      'error.session': '当前会话在后台不存在。',
      'error.refused': '后台拒绝本次操作，状态保持不变。',
      'error.unconfirmed': '后台未确认新状态。',
      'error.transport': '无法连接到 DSH 后台。',
      'error.auth': '浏览器会话未通过 DSH 认证，请刷新页面后重试。',
      'error.generic': '操作失败。',
      'panel.title': '上传钩子状态',
      'panel.subtitle': '每次打开都会重新扫描 DSH 的上传插件',
      'panel.refresh': '重新扫描',
      'panel.close': '关闭',
      'panel.scanning': '正在扫描 DSH 上传钩子…',
      'panel.scanError': '扫描失败：{error}',
      'panel.hooks': '检测到的上传钩子',
      'panel.noHooks': '没有发现上传钩子。',
      'panel.kind.voluntary': '自愿上传',
      'panel.kind.auto': '自动采集',
      'panel.kind.other': '其他 Langfuse 插件',
      'panel.active': '运行中',
      'panel.inactive': '未运行',
      'panel.switchYes': '有开关',
      'panel.switchNo': '无开关',
      'panel.conclusion.ok': '可控：自愿上传在运行，头部开关可以控制它。',
      'panel.conclusion.auto': '不可控：检测到原版自动采集，头部开关控制不了它。',
      'panel.conclusion.installable': '检测到原版自动采集，可以迁移为自愿上传。',
      'panel.conclusion.missing': '未检测到上传钩子。',
      'panel.conclusion.pending': '自愿上传已写入，但还没加载完成；可能需要重启 DSH。',
      'panel.badge.ok': '可控',
      'panel.badge.auto': '不可控',
      'panel.badge.installable': '可迁移',
      'panel.badge.pending': '待加载',
      'panel.badge.missing': '未安装',
      'panel.runtime': '运行时',
      'panel.dshVersion': 'DSH {version} · profile {profile}',
      'panel.voluntaryVersion': '自愿上传器：{version}',
      'panel.config': '配置',
      'panel.config.present': 'config.json 已就绪',
      'panel.config.missing': 'config.json 缺失：{path}',
      'panel.config.env': '环境变量可用',
      'panel.config.envNote': '应用时会用原版采集启动时的 LANGFUSE_* 环境变量生成 config.json（密钥只在 Host 侧写入，不会发送给浏览器）；目标：{host}',
      'panel.config.envMissing': '缺少环境变量：{fields}',
      'panel.module.present': '自愿上传器模块已就绪',
      'panel.module.vendor': '将使用插件内置副本安装自愿上传器',
      'panel.migration.title': '迁移为自愿上传',
      'panel.migration.desc': '将移除原版自动采集行、写入自愿上传行（默认关闭），并先备份被修改的配置文件。',
      'panel.migration.envNote': '检测到原版采集所用的 Langfuse 环境变量，应用时会先生成 config.json。',
      'panel.migration.button': '应用：改为自愿上传',
      'panel.migration.confirmTitle': '确认执行迁移？',
      'panel.migration.confirmDesc': '会先备份，再移除原版自动采集行，并写入默认关闭的自愿上传行；可能需要重启 DSH 才完全生效。',
      'panel.migration.confirm': '确认应用',
      'panel.migration.cancel': '取消',
      'panel.migration.running': '正在应用：备份 → 修改配置 → 等待加载…',
      'panel.migration.applied': '迁移完成。',
      'panel.migration.already': '无需迁移：自愿上传已在运行。',
      'panel.migration.restart': '配置已写入，但还需要重启 DSH 才能完全生效。',
      'panel.migration.partial': '自愿上传已加载，但原版采集仍在运行；请重启 DSH。',
      'panel.migration.failed': '迁移失败：{error}',
      'panel.migration.backups': '备份：{paths}',
      'panel.migration.changed': '已修改：{paths}',
      'panel.migration.configCreated': '已创建配置：{path}',
      'panel.migration.configMissing': '未迁移：缺少 config.json，请先把本机 Langfuse 配置放到该路径。',
      'panel.migration.closeHint': '按 Esc 或点击别处关闭',
      'panel.config.title': 'Langfuse 连接配置',
      'panel.config.desc': '安装后在这里填写连接信息并保存；配置 ≠ 开启上传，所有会话仍然默认关闭。',
      'panel.config.loading': '正在读取配置…',
      'panel.config.loadError': '读取配置失败：{error}',
      'panel.config.path': '配置文件：{path}',
      'panel.config.state.valid': '配置有效',
      'panel.config.state.invalid': '配置缺失或无效',
      'panel.config.state.ready': '上传器已读取配置',
      'panel.config.state.pending': '上传器尚未读取该配置，重启 DSH 后生效。',
      'panel.config.defaultOff': '默认关闭：保存配置不会开启任何会话的上传；需要上传时请按会话点开关。',
      'panel.config.keys': '公钥：{public}；私钥：{secret}',
      'panel.config.key.set': '已设置',
      'panel.config.key.setHint': '已设置（{hint}）',
      'panel.config.key.unset': '未设置',
      'panel.config.field.baseUrl': 'Langfuse 地址',
      'panel.config.field.publicKey': '公钥（publicKey）',
      'panel.config.field.secretKey': '私钥（secretKey）',
      'panel.config.field.userId': '工号（userId）',
      'panel.config.field.maxChars': '单条文本上限（maxChars）',
      'panel.config.placeholder.baseUrl': 'https://langfuse.example.com',
      'panel.config.placeholder.publicKey.set': '已设置（{hint}），留空保持不变',
      'panel.config.placeholder.publicKey.unset': '未设置，粘贴 pk-lf-… 开头的公钥',
      'panel.config.placeholder.secretKey.set': '已设置，留空保持不变（不会回显）',
      'panel.config.placeholder.secretKey.unset': '未设置，粘贴 sk-lf-… 开头的私钥',
      'panel.config.placeholder.userId': '工号，如 j60000000',
      'panel.config.placeholder.maxChars': '默认 20000',
      'panel.config.hint': '浏览器不会回显已保存的密钥；密钥字段留空表示保持原值。',
      'panel.config.save': '保存配置',
      'panel.config.saving': '正在保存…',
      'panel.config.saved': '已保存，仍默认关闭：配置不会开启任何会话的上传，需要时按会话点开关',
      'panel.config.saveFailed': '保存失败：{error}',
      'panel.config.uploader.title': '上传器',
      'panel.config.uploader.installed': '上传器已安装',
      'panel.config.uploader.missing': '上传器未安装',
      'panel.config.uploader.active': '运行中',
      'panel.config.uploader.inactive': '未运行',
      'panel.config.uploader.install': '安装上传器',
      'panel.config.uploader.installing': '正在安装：复制模块 → 写入 Loader 行…',
      'panel.config.uploader.installedOk': '上传器已安装。',
      'panel.config.uploader.restart': '上传器已写入，但还需要重启 DSH 才能加载。',
      'panel.config.uploader.failed': '安装失败：{error}',
      'panel.config.uploader.auto': '检测到原版自动采集行；请使用现有「迁移为自愿上传」流程，安装不会重复处理迁移。',
      'panel.config.uploader.moduleMissing': '插件内置的上传器副本缺失，无法安装。',
      'panel.config.reason.missing': '不能为空',
      'panel.config.reason.unparsable': '不是合法 URL',
      'panel.config.reason.not_http': '必须以 http:// 或 https:// 开头',
      'panel.config.reason.has_credentials': '不能包含用户名或密码',
      'panel.config.reason.not_origin': '必须是纯域名（不能带路径）',
      'panel.config.reason.publicKey.prefix': '必须以 pk-lf- 开头',
      'panel.config.reason.secretKey.prefix': '必须以 sk-lf- 开头',
      'panel.config.reason.secretKey.required_for_new_host': '更换 Langfuse 地址后需要重新填写',
      'panel.config.reason.userId.pattern': '格式不符合工号规则（如 j60000000）',
      'panel.config.reason.maxChars.not_number': '必须是数字',
      'panel.config.reason.maxChars.out_of_range': '必须是大于 0 的数字',
      'panel.config.reason.generic': '格式不正确',
      'panel.config.fieldError': '{field}：{reason}',
      'panel.config.error.writeFailed': '无法写入配置文件，请检查目录权限。',
      'panel.config.error.installFailed': '安装未完成：上传器模块或 Loader 行缺失。',
      'panel.config.error.busy': '已有一次安装正在进行，请稍后再试。',
    };

    const EN = {
      'label.title': 'Session upload',
      'label.titleShort': 'Upload',
      'state.on': 'on',
      'state.off': 'off',
      'state.loading': 'checking',
      'state.saving': 'saving',
      'state.unknown': 'unknown',
      'details.aria': 'Show details about this session upload (does not change the switch)',
      'label.on': 'Session upload: on',
      'label.off': 'Session upload: off',
      'label.loading': 'Session upload: checking',
      'label.saving': 'Session upload: saving',
      'label.unknown': 'Session upload: state unknown',
      'label.onShort': 'Session: on',
      'label.offShort': 'Session: off',
      'label.loadingShort': 'Session: checking',
      'label.savingShort': 'Session: saving',
      'label.unknownShort': 'Session: unknown',
      'aria.switch': 'Upload this session to the team Langfuse',
      'aria.unknown': 'Upload this session to the team Langfuse, state unknown, press to retry the query',
      hint: 'When enabled, turns that start in this session (prompts, answers, tool calls) are uploaded to the team Langfuse. Content already sent cannot be withdrawn.',
      scope: 'Applies to this session only. The /lf commands and the switch share one state. Click the left label for details; only the right switch toggles.',
      receipt: '"On" means consent is granted, not that every upload succeeded. Use /lf status for delivery results.',
      sendStats: 'This process confirmed {sent} turn(s); failed: {failed}.',
      lastError: 'Last delivery did not finish: {error}',
      retry: 'Press the button to re-query the Host (the consent change is not retried automatically).',
      'error.uploader': 'The upload plugin is not ready.',
      'error.session': 'This session is unknown to the Host.',
      'error.refused': 'The Host refused the operation; nothing changed.',
      'error.unconfirmed': 'The Host did not confirm the new state.',
      'error.transport': 'The DSH Host is unreachable.',
      'error.auth': 'The browser session is not authenticated by DSH. Refresh the page and retry.',
      'error.generic': 'The operation failed.',
      'panel.title': 'Upload hook status',
      'panel.subtitle': 'Scans the DSH upload plugins every time it opens',
      'panel.refresh': 'Rescan',
      'panel.close': 'Close',
      'panel.scanning': 'Scanning DSH upload hooks…',
      'panel.scanError': 'Scan failed: {error}',
      'panel.hooks': 'Detected upload hooks',
      'panel.noHooks': 'No upload hook was found.',
      'panel.kind.voluntary': 'Voluntary',
      'panel.kind.auto': 'Automatic',
      'panel.kind.other': 'Other Langfuse plugin',
      'panel.active': 'running',
      'panel.inactive': 'not running',
      'panel.switchYes': 'switch available',
      'panel.switchNo': 'no switch',
      'panel.conclusion.ok': 'Controllable: the voluntary uploader is running; the header switch controls it.',
      'panel.conclusion.auto': 'Not controllable: an automatic collector is running and the header switch cannot control it.',
      'panel.conclusion.installable': 'An automatic collector was found; it can be migrated to the voluntary uploader.',
      'panel.conclusion.missing': 'No upload hook was detected.',
      'panel.conclusion.pending': 'The voluntary row is written but not loaded yet; a DSH restart may be required.',
      'panel.badge.ok': 'Controllable',
      'panel.badge.auto': 'Not controllable',
      'panel.badge.installable': 'Migratable',
      'panel.badge.pending': 'Pending',
      'panel.badge.missing': 'Not installed',
      'panel.runtime': 'Runtime',
      'panel.dshVersion': 'DSH {version} · profile {profile}',
      'panel.voluntaryVersion': 'Voluntary uploader: {version}',
      'panel.config': 'Configuration',
      'panel.config.present': 'config.json is ready',
      'panel.config.missing': 'config.json is missing: {path}',
      'panel.config.env': 'Env vars available',
      'panel.config.envNote': 'Applying will create config.json from the LANGFUSE_* env the original collector used (keys are written on the Host only and never sent to the browser); target: {host}',
      'panel.config.envMissing': 'Missing env vars: {fields}',
      'panel.module.present': 'The voluntary uploader module is ready',
      'panel.module.vendor': 'The bundled copy will be installed as the voluntary uploader',
      'panel.migration.title': 'Migrate to voluntary upload',
      'panel.migration.desc': 'Removes the automatic collector rows, writes the voluntary row (default off), and backs up every changed config file first.',
      'panel.migration.envNote': 'The Langfuse env vars the original collector used were found; applying will create config.json first.',
      'panel.migration.button': 'Apply: switch to voluntary upload',
      'panel.migration.confirmTitle': 'Run the migration?',
      'panel.migration.confirmDesc': 'It backs up first, removes the automatic collector rows, writes a default-off voluntary row, and may need a DSH restart to take full effect.',
      'panel.migration.confirm': 'Confirm',
      'panel.migration.cancel': 'Cancel',
      'panel.migration.running': 'Applying: backup → patch config → wait for load…',
      'panel.migration.applied': 'Migration complete.',
      'panel.migration.already': 'Nothing to do: the voluntary uploader is already running.',
      'panel.migration.restart': 'The config was written but a DSH restart is required to take full effect.',
      'panel.migration.partial': 'The voluntary uploader is loaded, but the automatic collector still runs; restart DSH.',
      'panel.migration.failed': 'Migration failed: {error}',
      'panel.migration.backups': 'Backups: {paths}',
      'panel.migration.changed': 'Changed: {paths}',
      'panel.migration.configCreated': 'Config created: {path}',
      'panel.migration.configMissing': 'Not migrated: config.json is missing. Put this profile\'s Langfuse config there first.',
      'panel.migration.closeHint': 'Press Esc or click elsewhere to close',
      'panel.config.title': 'Langfuse connection config',
      'panel.config.desc': 'Fill in and save the connection details after installing. Config is not consent: every session stays off by default.',
      'panel.config.loading': 'Reading the config…',
      'panel.config.loadError': 'Could not read the config: {error}',
      'panel.config.path': 'Config file: {path}',
      'panel.config.state.valid': 'Config valid',
      'panel.config.state.invalid': 'Config missing or invalid',
      'panel.config.state.ready': 'Uploader loaded the config',
      'panel.config.state.pending': 'The uploader has not loaded this config yet; restart DSH to apply it.',
      'panel.config.defaultOff': 'Off by default: saving the config never enables uploads for any session. Use the per-session switch when needed.',
      'panel.config.keys': 'Public key: {public}; secret key: {secret}',
      'panel.config.key.set': 'set',
      'panel.config.key.setHint': 'set ({hint})',
      'panel.config.key.unset': 'not set',
      'panel.config.field.baseUrl': 'Langfuse URL',
      'panel.config.field.publicKey': 'Public key (publicKey)',
      'panel.config.field.secretKey': 'Secret key (secretKey)',
      'panel.config.field.userId': 'User ID (userId)',
      'panel.config.field.maxChars': 'Max characters (maxChars)',
      'panel.config.placeholder.baseUrl': 'https://langfuse.example.com',
      'panel.config.placeholder.publicKey.set': 'Set ({hint}); leave blank to keep it',
      'panel.config.placeholder.publicKey.unset': 'Not set; paste the pk-lf-… public key',
      'panel.config.placeholder.secretKey.set': 'Set; leave blank to keep it (never echoed)',
      'panel.config.placeholder.secretKey.unset': 'Not set; paste the sk-lf-… secret key',
      'panel.config.placeholder.userId': 'Employee number, e.g. j60000000',
      'panel.config.placeholder.maxChars': 'Default 20000',
      'panel.config.hint': 'Saved keys are never echoed to the browser; a blank key field keeps the stored value.',
      'panel.config.save': 'Save config',
      'panel.config.saving': 'Saving…',
      'panel.config.saved': 'Saved, still off by default: the config does not enable uploads for any session; use the per-session switch when needed',
      'panel.config.saveFailed': 'Save failed: {error}',
      'panel.config.uploader.title': 'Uploader',
      'panel.config.uploader.installed': 'Uploader installed',
      'panel.config.uploader.missing': 'Uploader not installed',
      'panel.config.uploader.active': 'running',
      'panel.config.uploader.inactive': 'not running',
      'panel.config.uploader.install': 'Install uploader',
      'panel.config.uploader.installing': 'Installing: copying the module → writing the Loader row…',
      'panel.config.uploader.installedOk': 'The uploader is installed.',
      'panel.config.uploader.restart': 'The uploader was written but a DSH restart is required to load it.',
      'panel.config.uploader.failed': 'Install failed: {error}',
      'panel.config.uploader.auto': 'An original automatic collector row is present; use the existing "Migrate to voluntary upload" flow. Install never performs that migration.',
      'panel.config.uploader.moduleMissing': 'The bundled uploader copy is missing, so it cannot be installed.',
      'panel.config.reason.missing': 'must not be empty',
      'panel.config.reason.unparsable': 'is not a valid URL',
      'panel.config.reason.not_http': 'must start with http:// or https://',
      'panel.config.reason.has_credentials': 'must not contain a username or password',
      'panel.config.reason.not_origin': 'must be a bare origin (no path)',
      'panel.config.reason.publicKey.prefix': 'must start with pk-lf-',
      'panel.config.reason.secretKey.prefix': 'must start with sk-lf-',
      'panel.config.reason.secretKey.required_for_new_host': 'must be re-entered after changing the Langfuse address',
      'panel.config.reason.userId.pattern': 'does not match the employee-number pattern (e.g. j60000000)',
      'panel.config.reason.maxChars.not_number': 'must be a number',
      'panel.config.reason.maxChars.out_of_range': 'must be greater than 0',
      'panel.config.reason.generic': 'is not valid',
      'panel.config.fieldError': '{field}: {reason}',
      'panel.config.error.writeFailed': 'Could not write the config file; check the directory permissions.',
      'panel.config.error.installFailed': 'Install did not finish: the uploader module or its Loader row is missing.',
      'panel.config.error.busy': 'Another install is running; retry in a moment.',
    };

    const CSS = `
.lfh-root{display:inline-flex;align-items:center;gap:1px;min-width:0;font:inherit}
/* Two independent targets: the left label only reveals details; the right
   switch is the only thing that changes consent. */
.lfh-label{display:inline-flex;align-items:center;height:22px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm,6px);
  background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:12px;line-height:1;white-space:nowrap;
  cursor:pointer;transition:background-color .12s ease,color .12s ease}
@media (hover:hover){.lfh-label:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329)}}
.lfh-label:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2f6fed))}
.lfh-switch{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 4px;border:0;border-radius:999px;
  background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:12px;line-height:1;white-space:nowrap;
  cursor:pointer;transition:background-color .12s ease,color .12s ease}
@media (hover:hover){.lfh-switch:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}}
.lfh-switch:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2f6fed))}
.lfh-switch[aria-disabled="true"]{cursor:progress}
.lfh-state{min-width:2.2em;text-align:right}
/* State text keeps WCAG AA contrast: the token tone is blended toward the host
   label color so it darkens on light surfaces and lightens on dark surfaces.
   The plain token declaration is the fallback when color-mix is unavailable. */
.lfh-switch[data-state="on"] .lfh-state{color:var(--dsw-alias-state-success-primary,#0f7b3f);
  color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 55%,var(--dsw-alias-label-primary,#1f2329))}
.lfh-switch[data-state="unknown"] .lfh-state{color:var(--dsw-alias-state-error-primary,#b3261e);
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 78%,var(--dsw-alias-label-primary,#1f2329))}
.lfh-track{position:relative;flex:none;width:26px;height:14px;border-radius:999px;box-sizing:border-box;
  background:var(--dsw-alias-border-l3,#c9ced6);transition:background-color .15s ease}
.lfh-knob{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .15s ease}
.lfh-switch[data-state="on"] .lfh-track{background:var(--dsw-alias-state-success-primary,#22c55e)}
.lfh-switch[data-state="on"] .lfh-knob{transform:translateX(12px)}
.lfh-switch[data-state="unknown"] .lfh-track{background:var(--dsw-alias-state-error-primary,#ec1313)}
.lfh-switch[data-state="loading"] .lfh-track,.lfh-switch[data-state="saving"] .lfh-track{animation:lfh-pulse 1s ease-in-out infinite}
@keyframes lfh-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){
  .lfh-track,.lfh-knob,.lfh-label,.lfh-switch{transition:none}
  .lfh-track{animation:none!important}
}
.lfh-short{display:none}
@container (max-width: 560px){.lfh-long{display:none}.lfh-short{display:inline}}
.lfh-tip{position:fixed;z-index:2147483000;box-sizing:border-box;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-alias-tooltip-label,#ffffff);
  box-shadow:0 3px 12px rgba(0,0,0,.18);font-size:13px;line-height:20px;pointer-events:none;
  display:flex;flex-direction:column;gap:3px}
.lfh-tip-line{display:block}
.lfh-tip-state{display:block;font-weight:600}
.lfh-tip-scope{display:block;color:var(--dsw-alias-tooltip-label-secondary,rgba(255,255,255,.78))}
.lfh-tip-error{display:block;color:var(--dsw-alias-state-warn-primary,#f5a623)}
.lfh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.lfh-panel{position:fixed;z-index:2147483001;box-sizing:border-box;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;
  box-shadow:0 10px 30px rgba(0,0,0,.20);font-size:12px;line-height:18px;overflow:hidden}
.lfh-panel-head{display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  background:var(--dsw-alias-bg-elevated,rgba(0,0,0,.02))}
.lfh-panel-title{flex:1;font-size:13px;font-weight:600}
.lfh-panel-sub{display:block;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary,#5f6368)}
.lfh-panel-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:11px;line-height:16px;
  padding:2px 8px;cursor:pointer;white-space:nowrap}
.lfh-panel-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.lfh-panel-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2f6fed)}
.lfh-panel-btn[disabled]{opacity:.55;cursor:progress}
.lfh-panel-close{border:0;background:transparent;font-size:15px;line-height:16px;padding:0 4px;border-radius:6px}
.lfh-panel-body{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.lfh-panel-section{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6368);margin-top:2px}
.lfh-panel-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.lfh-panel-badge{display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));color:var(--dsw-alias-label-secondary,#5f6368)}
.lfh-panel-badge.ok{color:var(--dsw-alias-state-success-primary,#0f7b3f);border-color:rgba(15,123,63,.4)}
.lfh-panel-badge.bad{color:var(--dsw-alias-state-error-primary,#b3261e);border-color:rgba(179,38,30,.4)}
.lfh-panel-badge.warn{color:var(--dsw-alias-state-warn-primary,#a05a00);border-color:rgba(160,90,0,.4)}
.lfh-panel-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.lfh-panel-item{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.035));
  display:flex;flex-direction:column;gap:2px}
.lfh-panel-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  color:var(--dsw-alias-label-secondary,#5f6368);word-break:break-all}
.lfh-panel-line{display:block}
.lfh-panel-note{color:var(--dsw-alias-label-secondary,#5f6368)}
.lfh-panel-warn{padding:7px 8px;border-radius:8px;background:rgba(160,90,0,.10);color:var(--dsw-alias-label-primary,#1f2329)}
.lfh-panel-ok{color:var(--dsw-alias-state-success-primary,#0f7b3f)}
.lfh-panel-bad{color:var(--dsw-alias-state-error-primary,#b3261e)}
.lfh-panel-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.lfh-panel-primary{appearance:none;border:1px solid transparent;border-radius:6px;font:inherit;font-size:12px;
  line-height:18px;padding:3px 10px;cursor:pointer;background:var(--dsw-alias-brand-primary,#2f6fed);color:#fff}
.lfh-panel-primary:hover{filter:brightness(1.05)}
.lfh-panel-primary:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2f6fed)}
.lfh-panel-primary[disabled]{opacity:.6;cursor:progress}
.lfh-config{display:flex;flex-direction:column;gap:6px}
.lfh-config-form{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.lfh-field{display:flex;flex-direction:column;gap:2px}
.lfh-field-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6368)}
.lfh-input{box-sizing:border-box;width:100%;padding:3px 6px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);
  font:inherit;font-size:12px;line-height:18px}
.lfh-input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2f6fed)}
.lfh-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary,#b3261e)}
.lfh-input:disabled{opacity:.6}
.lfh-field-error{color:var(--dsw-alias-state-error-primary,#b3261e);font-size:11px;line-height:16px}
`;

    /**
     * Create the guard that decides whether an asynchronous answer may still
     * change this header. Every network answer carries the session identity and
     * the token of the operation that started it; only an answer for the
     * current session, still being the newest of its kind, with no mutation in
     * flight, is accepted.
     *
     * @param {string} initialSession - session bound when the cell mounts.
     * @returns {object} gate used by the component's effects and handlers.
     */
    function createAnswerGate(initialSession) {
      let session = initialSession;
      let queryToken = 0;
      let mutationToken = 0;
      let busy = false;
      return {
        get session() { return session; },
        get busy() { return busy; },
        /** Bind the gate to the rendered session, invalidating older answers. */
        setSession(next) {
          if (next === session) return;
          session = next;
          queryToken += 1;
          mutationToken += 1;
          busy = false;
        },
        /** Invalidate everything owned by this gate (unmount). */
        dispose() {
          queryToken += 1;
          mutationToken += 1;
        },
        /**
         * Claim a query token for one session.
         * @returns {number} nonzero token, or 0 when no query may start.
         */
        beginQuery(target) {
          if (busy || target !== session) return 0;
          return ++queryToken;
        },
        /** Whether a query answer may still be applied. */
        acceptQuery(target, token) {
          return token !== 0 && target === session && token === queryToken && !busy;
        },
        /**
         * Claim a mutation token for one session. Invalidates in-flight queries
         * so a slow query cannot overwrite the confirmed result.
         * @returns {number} nonzero token, or 0 when a mutation is already in flight.
         */
        beginMutation(target) {
          if (busy || target !== session) return 0;
          busy = true;
          queryToken += 1;
          return ++mutationToken;
        },
        /** Whether a mutation answer may still be applied. */
        acceptMutation(target, token) {
          return token !== 0 && target === session && token === mutationToken;
        },
        /** Release the busy flag when this mutation settles. */
        endMutation(target, token) {
          if (target === session && token === mutationToken) busy = false;
        },
      };
    }

    /**
     * Normalize a thrown transport failure into the local failure shape.
     * 401/403 are reported as an authentication problem, not a generic network one.
     * @param {unknown} error - thrown value from the fetch wrapper.
     * @returns {{ error: { code: string, message: string } }} local failure detail.
     */
    function failureDetail(error) {
      const message = String(error && error.message ? error.message : '');
      return { error: { code: message === 'unauthorized' ? 'auth' : 'transport', message } };
    }

    /**
     * Map an RPC failure envelope to one localized short sentence.
     * @param {any} detail - failure detail captured from the result.
     * @param {Function} t - namespace translator.
     * @returns {string} localized reason.
     */
    function errorText(detail, t) {
      const error = detail !== null && detail !== undefined && typeof detail === 'object' ? detail.error : undefined;
      const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : '';
      switch (code) {
        case 'uploader_unavailable': return t('error.uploader');
        case 'session_not_found': return t('error.session');
        case 'uploader_refused': return t('error.refused');
        case 'state_not_confirmed': return t('error.unconfirmed');
        case 'auth': return t('error.auth');
        case 'transport': return t('error.transport');
        default: return t('error.generic');
      }
    }

    /**
     * Normalize an RPC result into the component's view model.
     * A result that does not carry an explicit boolean `enabled` becomes
     * "unknown" — never "off", so a failed query cannot pretend consent was
     * revoked, and never "on", so it cannot pretend consent exists.
     * @param {any} result - Connection RPC result.
     * @returns {{ kind: string, enabled: boolean, detail: any }} view model.
     */
    function normalizeResult(result) {
      if (result !== null && typeof result === 'object' && result.ok === true
        && result.value !== null && typeof result.value === 'object'
        && typeof result.value.enabled === 'boolean') {
        return { kind: 'ready', enabled: result.value.enabled, detail: result.value };
      }
      const error = result !== null && typeof result === 'object' && result.error !== null && typeof result.error === 'object'
        ? { code: String(result.error.code || ''), message: String(result.error.message || '').slice(0, 200) }
        : { code: 'transport', message: '' };
      return { kind: 'unknown', enabled: false, detail: { error } };
    }

    /**
     * Extract the redacted config status from a `/config` answer.
     * `get` and `save` answer with `value`; `install` answers with `status`.
     * @param {any} result - RPC result envelope.
     * @returns {object | null} status object, or null when absent.
     */
    function configStatusOf(result) {
      if (result === null || typeof result !== 'object' || result.ok !== true) return null;
      const candidate = result.value ?? result.status;
      return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
    }

    /**
     * Build the controlled form state from a status snapshot. Key fields always
     * start blank: the Host never sends key material back.
     * @param {any} status - redacted config status.
     * @returns {{ baseUrl: string, publicKey: string, secretKey: string, userId: string, maxChars: string }} form state.
     */
    function configFormFromStatus(status) {
      const maxChars = status !== null && typeof status === 'object' && Number.isInteger(status.maxChars)
        ? status.maxChars
        : 20000;
      return {
        baseUrl: typeof status?.baseUrl === 'string' ? status.baseUrl : '',
        publicKey: '',
        secretKey: '',
        userId: typeof status?.userId === 'string' ? status.userId : '',
        maxChars: String(maxChars),
      };
    }

    /**
     * Localize one key-presence label.
     * @param {Function} t - namespace translator.
     * @param {boolean} set - whether the Host has a stored value.
     * @param {string | null} hint - optional redacted hint.
     * @returns {string} localized label.
     */
    function configKeyText(t, set, hint) {
      if (set !== true) return t('panel.config.key.unset');
      return typeof hint === 'string' && hint.length > 0
        ? t('panel.config.key.setHint', { hint })
        : t('panel.config.key.set');
    }

    /**
     * Localize a field-scoped validation failure.
     * @param {Function} t - namespace translator.
     * @param {string | null} field - Host field id.
     * @param {string} reason - Host reason code.
     * @returns {string} "field: reason" sentence or a generic fallback.
     */
    function configFieldErrorText(t, field, reason) {
      if (typeof field !== 'string' || field.length === 0) return t('panel.config.reason.generic');
      const fieldKey = `panel.config.field.${field}`;
      const fieldLabel = t(fieldKey);
      const fieldText = typeof fieldLabel === 'string' && fieldLabel !== fieldKey ? fieldLabel : field;
      let reasonText = t('panel.config.reason.generic');
      if (typeof reason === 'string' && reason.length > 0) {
        const specificKey = `panel.config.reason.${field}.${reason}`;
        const specific = t(specificKey);
        if (typeof specific === 'string' && specific !== specificKey) {
          reasonText = specific;
        } else {
          const genericKey = `panel.config.reason.${reason}`;
          const generic = t(genericKey);
          if (typeof generic === 'string' && generic !== genericKey) reasonText = generic;
        }
      }
      return t('panel.config.fieldError', { field: fieldText, reason: reasonText });
    }

    /**
     * Localize one config/install failure code without exposing Host text.
     * @param {Function} t - namespace translator.
     * @param {string} code - stable failure code.
     * @returns {string} localized reason.
     */
    function configErrorText(t, code) {
      switch (code) {
        case 'transport': return t('error.transport');
        case 'auth': return t('error.auth');
        case 'write_failed': return t('panel.config.error.writeFailed');
        case 'module_missing': return t('panel.config.uploader.moduleMissing');
        case 'auto_collector_present': return t('panel.config.uploader.auto');
        case 'install_failed': return t('panel.config.error.installFailed');
        case 'busy': return t('panel.config.error.busy');
        default: return t('error.generic');
      }
    }

    /**
     * One session's upload switch.
     *
     * @param {object} props - slot runtime props plus the registration inject face.
     * @param {string} props.sessionId - exact session bound to this header.
     * @param {Function} props.t - namespace translator supplied by the slot.
     * @param {Function} props.queryUpload - Host state query.
     * @param {Function} props.setUpload - Host explicit decision.
     * @param {Function} props.subscribeConnection - Connection generation changes.
     */
    function UploadToggle(props) {
      const { sessionId, t, queryUpload, setUpload, subscribeConnection } = props;
      // `__initialView` is an internal test seam (never supplied by the Host
      // slot) so the offline structure test can render a confirmed state.
      const [view, setView] = React.useState(() => props.__initialView ?? ({ kind: 'loading', enabled: false, detail: null }));
      const [busy, setBusy] = React.useState(false);
      const [tipHover, setTipHover] = React.useState(false);
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [scan, setScan] = React.useState({ phase: 'idle', data: null, error: null });
      const [applyState, setApplyState] = React.useState({ phase: 'idle', error: null, result: null });
      const [config, setConfig] = React.useState({ phase: 'idle', status: null, error: null });
      const [configForm, setConfigForm] = React.useState({
        baseUrl: '', publicKey: '', secretKey: '', userId: '', maxChars: '20000',
      });
      const [configSave, setConfigSave] = React.useState({ phase: 'idle', field: null, reason: null, error: null });
      const [configInstall, setConfigInstall] = React.useState({ phase: 'idle', restartRequired: false, error: null });
      const panelRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const gateRef = React.useRef(null);
      const hintId = React.useId();

      // A cell that changes session without remounting must never keep the
      // previous session's answers or busy state.
      if (gateRef.current === null || gateRef.current.session !== sessionId) {
        gateRef.current = createAnswerGate(sessionId);
      }
      const gate = gateRef.current;

      const settle = React.useCallback((result) => {
        setView(normalizeResult(result));
      }, []);

      /**
       * Query the Host for this exact session. Answers for another session or
       * for a superseded request are dropped by the gate.
       * @param {string} target - session identity captured by the caller.
       */
      const refresh = React.useCallback(async (target) => {
        const token = gate.beginQuery(target);
        if (token === 0) return;
        try {
          const result = await queryUpload(target);
          if (!gate.acceptQuery(target, token)) return;
          settle(result);
        } catch (error) {
          if (!gate.acceptQuery(target, token)) return;
          settle(failureDetail(error));
        }
      }, [gate, queryUpload, settle]);

      React.useEffect(() => {
        const target = sessionId;
        gate.setSession(target);
        setBusy(false);
        setView({ kind: 'loading', enabled: false, detail: null });

        let disposed = false;
        const tick = () => {
          if (disposed) return;
          // A hidden page cannot press anything; skip background polls until
          // it becomes visible again (the visibilitychange handler refreshes).
          if (document.visibilityState === 'hidden') return;
          void refresh(target);
        };
        tick();
        const timer = setInterval(tick, POLL_INTERVAL_MS);
        const onFocus = () => { tick(); };
        const onVisibility = () => {
          if (document.visibilityState === 'visible') tick();
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        const stop = typeof subscribeConnection === 'function' ? subscribeConnection(tick) : undefined;
        return () => {
          disposed = true;
          gate.dispose();
          setTipHover(false);
          setPanelOpen(false);
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          document.removeEventListener('visibilitychange', onVisibility);
          if (typeof stop === 'function') stop();
        };
      }, [sessionId, gate, refresh, subscribeConnection]);

      /**
       * Handle one activation: a ready control toggles consent; an unknown one
       * retries the query. The operation is awaited and only the confirmed
       * state is rendered.
       */
      const onActivate = React.useCallback(() => {
        const target = sessionId;
        if (gate.busy) return;
        if (view.kind !== 'ready') {
          setView({ kind: 'loading', enabled: false, detail: null });
          void refresh(target);
          return;
        }
        const next = view.enabled !== true;
        const token = gate.beginMutation(target);
        if (token === 0) return;
        setBusy(true);
        void (async () => {
          try {
            const result = await setUpload(target, next);
            if (!gate.acceptMutation(target, token)) return;
            // A success confirms exactly the state the Host reports; anything
            // else (refusal, unconfirmed state, transport failure) normalizes
            // to "unknown" instead of pretending the switch flipped.
            settle(result);
          } catch (error) {
            if (!gate.acceptMutation(target, token)) return;
            settle(failureDetail(error));
          } finally {
            gate.endMutation(target, token);
            if (gate.session === target && !gate.busy) setBusy(false);
          }
        })();
      }, [gate, sessionId, view, refresh, setUpload, settle]);

      const stateKey = busy ? 'saving' : view.kind === 'loading' ? 'loading' : view.kind === 'unknown' ? 'unknown' : view.enabled ? 'on' : 'off';
      const stateLabel = t('state.' + stateKey);
      const fullLabel = t('label.' + stateKey);
      // Only a Host-confirmed state may present switch semantics; loading and
      // unknown render the right control as a plain button so AT never hears
      // "unchecked" for an unconfirmed consent state.
      const confirmed = view.kind === 'ready';
      const showTip = tipHover && !panelOpen;

      // Hover opens the quick tooltip after a short delay like the host
      // tooltip; keyboard focus opens it immediately. The left label click
      // opens the scan panel instead and never changes consent.
      const hoverTimer = React.useRef(null);
      const openTipSoon = React.useCallback(() => {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          setTipHover(true);
        }, 450);
      }, []);
      const openTipNow = React.useCallback(() => {
        if (hoverTimer.current !== null) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
        setTipHover(true);
      }, []);
      const closeTipHover = React.useCallback(() => {
        if (hoverTimer.current !== null) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
        setTipHover(false);
      }, []);
      React.useEffect(() => () => {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      }, []);

      /**
       * Scan the Host for upload hooks. Runs on every panel open and whenever
       * the user presses "rescan"; the panel never caches an earlier answer.
       * @returns {Promise<void>} resolves when the panel state settled.
       */
      const runScan = React.useCallback(async () => {
        setScan({ phase: 'loading', data: null, error: null });
        try {
          const result = await postJson(ROUTES.scan, {});
          if (result !== null && typeof result === 'object' && result.voluntary !== null && typeof result.voluntary === 'object') {
            setScan({ phase: 'ready', data: result, error: null });
          } else {
            setScan({ phase: 'error', data: null, error: t('error.generic') });
          }
        } catch (error) {
          setScan({ phase: 'error', data: null, error: errorText(failureDetail(error), t) });
        }
      }, [t]);

      /**
       * Read the redacted connection-config status from the Host and reset the
       * form. Runs only when the user opens the panel (or presses retry): the
       * form must never expand or submit on page load.
       * @returns {Promise<void>} resolves when the status settled.
       */
      const loadConfig = React.useCallback(async () => {
        setConfig(current => ({ ...current, phase: 'loading', error: null }));
        try {
          const result = await postJson(ROUTES.config, { action: 'get' });
          const status = configStatusOf(result);
          if (status === null) {
            setConfig({ phase: 'error', status: null, error: t('error.generic') });
            return;
          }
          setConfig({ phase: 'ready', status, error: null });
          setConfigForm(configFormFromStatus(status));
        } catch (error) {
          setConfig({ phase: 'error', status: null, error: errorText(failureDetail(error), t) });
        }
      }, [t]);

      /**
       * Save the form through `/config` with `action: "save"`. The Host owns
       * validation; its field-scoped failure is rendered next to that input.
       * @returns {Promise<void>} resolves when the save settled.
       */
      const saveConfigForm = React.useCallback(async () => {
        if (configSave.phase === 'saving') return;
        setConfigSave({ phase: 'saving', field: null, reason: null, error: null });
        const payload = {
          action: 'save',
          baseUrl: configForm.baseUrl,
          userId: configForm.userId,
          maxChars: configForm.maxChars,
        };
        if (configForm.publicKey.trim().length > 0) payload.publicKey = configForm.publicKey.trim();
        if (configForm.secretKey.trim().length > 0) payload.secretKey = configForm.secretKey.trim();
        try {
          const result = await postJson(ROUTES.config, payload);
          if (result !== null && result.ok === true) {
            const status = configStatusOf(result);
            if (status !== null) {
              setConfig({ phase: 'ready', status, error: null });
              setConfigForm(configFormFromStatus(status));
            }
            setConfigSave({ phase: 'saved', field: null, reason: null, error: null });
            void runScan();
            return;
          }
          const error = result !== null && typeof result === 'object' ? result.error ?? {} : {};
          setConfigSave({
            phase: 'error',
            field: typeof error.details?.field === 'string' ? error.details.field : null,
            reason: typeof error.details?.reason === 'string' ? error.details.reason : '',
            error: typeof error.code === 'string' ? error.code : 'generic',
          });
        } catch (caught) {
          setConfigSave({ phase: 'error', field: null, reason: '', error: failureDetail(caught).error.code });
        }
      }, [configForm, configSave.phase, runScan]);

      /**
       * Install the vendored uploader and its Loader row through `/config` with
       * `action: "install"`. Installing never enables any session.
       * @returns {Promise<void>} resolves when the install settled.
       */
      const installConfigUploader = React.useCallback(async () => {
        if (configInstall.phase === 'running') return;
        setConfigInstall({ phase: 'running', restartRequired: false, error: null });
        try {
          const result = await postJson(ROUTES.config, { action: 'install' });
          const status = configStatusOf(result);
          if (status !== null) setConfig({ phase: 'ready', status, error: null });
          if (result !== null && typeof result === 'object' && result.ok === true) {
            setConfigInstall({ phase: 'done', restartRequired: result.restartRequired === true, error: null });
            void runScan();
            return;
          }
          const code = result !== null && typeof result === 'object' && typeof result.error?.code === 'string'
            ? result.error.code
            : 'generic';
          setConfigInstall({ phase: 'error', restartRequired: false, error: code });
        } catch (caught) {
          setConfigInstall({ phase: 'error', restartRequired: false, error: failureDetail(caught).error.code });
        }
      }, [configInstall.phase, runScan]);

      const refreshPanel = React.useCallback(() => {
        void runScan();
        void loadConfig();
      }, [runScan, loadConfig]);

      const openPanel = React.useCallback(() => {
        setPanelOpen(true);
        setApplyState({ phase: 'idle', error: null, result: null });
        setConfigSave({ phase: 'idle', field: null, reason: null, error: null });
        setConfigInstall({ phase: 'idle', restartRequired: false, error: null });
        void runScan();
        void loadConfig();
      }, [loadConfig, runScan]);

      React.useEffect(() => {
        if (!panelOpen) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (panelRef.current !== null && target instanceof Node && panelRef.current.contains(target)) return;
          if (rootRef.current !== null && target instanceof Node && rootRef.current.contains(target)) return;
          setPanelOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPanelOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [panelOpen]);

      const requestApply = React.useCallback(() => {
        setApplyState({ phase: 'confirm', error: null, result: null });
      }, []);
      const cancelApply = React.useCallback(() => {
        setApplyState({ phase: 'idle', error: null, result: null });
      }, []);
      const confirmApply = React.useCallback(async () => {
        setApplyState({ phase: 'applying', error: null, result: null });
        try {
          const result = await postJson(ROUTES.migrate, { confirm: true });
          setApplyState({ phase: 'done', error: null, result });
          await runScan();
        } catch (error) {
          setApplyState({ phase: 'error', error: errorText(failureDetail(error), t), result: null });
        }
      }, [runScan, t]);

      let tipStyle = { display: 'none' };
      if (showTip && rootRef.current !== null) {
        const rect = rootRef.current.getBoundingClientRect();
        const viewport = typeof window !== 'undefined' ? window.innerWidth : 0;
        const left = Math.max(8, Math.min(Math.round(rect.left), Math.max(8, viewport - TOOLTIP_WIDTH - 8)));
        tipStyle = {
          position: 'fixed',
          top: Math.round(rect.bottom + 8) + 'px',
          left: left + 'px',
          maxWidth: TOOLTIP_WIDTH + 'px',
        };
      }

      const lines = [createElement('span', { key: 'state', className: 'lfh-tip-state' }, fullLabel)];
      lines.push(createElement('span', { key: 'hint', className: 'lfh-tip-line' }, t('hint')));
      lines.push(createElement('span', { key: 'scope', className: 'lfh-tip-scope' }, t('scope')));
      if (confirmed) {
        const detail = view.detail;
        const sent = detail !== null && Number.isInteger(detail.sent) ? detail.sent : 0;
        const failed = detail !== null && Number.isInteger(detail.failed) ? detail.failed : 0;
        lines.push(createElement('span', { key: 'stats', className: 'lfh-tip-scope' }, t('sendStats', { sent, failed })));
        lines.push(createElement('span', { key: 'receipt', className: 'lfh-tip-scope' }, t('receipt')));
        const last = detail !== null && detail.last !== null && typeof detail.last === 'object' ? detail.last : null;
        if (last !== null && last.ok === false) {
          lines.push(createElement('span', { key: 'last', className: 'lfh-tip-error' },
            t('lastError', { error: String(last.error || 'unknown') })));
        }
      }
      if (view.kind === 'unknown' && view.detail !== null && view.detail !== undefined) {
        lines.push(createElement('span', { key: 'error', className: 'lfh-tip-error' },
          errorText(view.detail, t) + ' ' + t('retry')));
      }

      const el = createElement;
      let panelStyle = { display: 'none' };
      if (panelOpen && rootRef.current !== null && typeof window !== 'undefined') {
        const rect = rootRef.current.getBoundingClientRect();
        const width = Math.min(PANEL_WIDTH, Math.max(320, window.innerWidth - 16));
        const left = Math.max(8, Math.min(Math.round(rect.left), Math.max(8, window.innerWidth - width - 8)));
        const top = Math.round(rect.bottom + 8);
        panelStyle = {
          position: 'fixed',
          top: `${top}px`,
          left: `${left}px`,
          width: `${width}px`,
          maxHeight: `${Math.max(200, window.innerHeight - top - 12)}px`,
        };
      }
      const badge = (text, tone) => el('span', { className: `lfh-panel-badge${tone ? ` ${tone}` : ''}` }, text);
      const panelBody = [];
      if (scan.phase === 'loading' || scan.phase === 'idle') {
        panelBody.push(el('span', { key: 'scanning', className: 'lfh-panel-note' }, t('panel.scanning')));
      } else if (scan.phase === 'error') {
        panelBody.push(el('span', { key: 'scanError', className: 'lfh-panel-bad' },
          t('panel.scanError', { error: String(scan.error || '') })));
        panelBody.push(el('div', { key: 'scanRetry', className: 'lfh-panel-actions' },
          el('button', { type: 'button', className: 'lfh-panel-btn', onClick: refreshPanel }, t('panel.refresh'))));
      } else if (scan.phase === 'ready' && scan.data !== null) {
        const data = scan.data;
        const autoHooks = Array.isArray(data.auto) ? data.auto : [];
        const autoActive = autoHooks.some(hook => hook.active === true);
        const voluntaryRuntime = data.voluntary?.runtime === true;
        const voluntaryPresent = data.voluntary?.present === true;
        const controllable = data.switch?.controllable === true;
        const migrationAvailable = data.migration?.available === true;
        let conclusion = 'missing';
        if (controllable) conclusion = 'ok';
        else if (migrationAvailable) conclusion = 'installable';
        else if (autoActive) conclusion = 'auto';
        else if (voluntaryPresent) conclusion = 'pending';
        const conclusionTone = conclusion === 'ok' ? 'ok' : (conclusion === 'auto' || conclusion === 'missing') ? 'bad' : 'warn';
        panelBody.push(el('div', { key: 'conclusion', className: 'lfh-panel-row' },
          badge(t(`panel.badge.${conclusion}`), conclusionTone),
          el('span', {}, t(`panel.conclusion.${conclusion}`))));

        panelBody.push(el('div', { key: 'hooksHead', className: 'lfh-panel-section' }, t('panel.hooks')));
        const hooks = Array.isArray(data.hooks) ? data.hooks : [];
        if (hooks.length === 0) {
          panelBody.push(el('span', { key: 'noHooks', className: 'lfh-panel-note' }, t('panel.noHooks')));
        } else {
          panelBody.push(el('ul', { key: 'hookList', className: 'lfh-panel-list' },
            ...hooks.map((hook, index) => {
              const kind = String(hook.kind || 'other');
              const kindTone = kind === 'voluntary' ? 'ok' : kind === 'auto' ? 'bad' : '';
              const hasSwitch = kind === 'voluntary' && voluntaryRuntime;
              return el('li', { key: `hook-${index}`, className: 'lfh-panel-item' },
                el('div', { className: 'lfh-panel-row' },
                  badge(t(`panel.kind.${kind}`) || kind, kindTone),
                  badge(String(hook.active === true ? t('panel.active') : t('panel.inactive')), hook.active === true ? 'ok' : ''),
                  badge(String(hasSwitch ? t('panel.switchYes') : t('panel.switchNo')), hasSwitch ? 'ok' : 'warn'),
                ),
                el('code', { className: 'lfh-panel-code' }, String(hook.entryId || '')),
                hook.moduleName ? el('code', { className: 'lfh-panel-code' }, String(hook.moduleName)) : null,
              );
            })));
        }

        panelBody.push(el('div', { key: 'runtimeHead', className: 'lfh-panel-section' }, t('panel.runtime')));
        const dsh = data.dsh ?? {};
        panelBody.push(el('div', { key: 'dshRow', className: 'lfh-panel-row' },
          el('span', { className: 'lfh-panel-note' },
            t('panel.dshVersion', { version: String(dsh.version || '?'), profile: String(dsh.profile || '?') }))));
        if (voluntaryRuntime) {
          panelBody.push(el('div', { key: 'volRow', className: 'lfh-panel-row lfh-panel-ok' },
            t('panel.voluntaryVersion', { version: String(data.voluntary?.version || '?') })));
        } else if (voluntaryPresent) {
          panelBody.push(el('div', { key: 'volRow', className: 'lfh-panel-row lfh-panel-bad' }, t('panel.conclusion.pending')));
        }

        panelBody.push(el('div', { key: 'configHead', className: 'lfh-panel-section' }, t('panel.config')));
        const voluntary = data.voluntary ?? {};
        if (voluntary.configPresent === true) {
          panelBody.push(el('div', { key: 'cfgRow', className: 'lfh-panel-row' },
            badge(t('panel.config.present'), 'ok'),
            el('code', { className: 'lfh-panel-code' }, String(voluntary.configPath || ''))));
        } else if (data.migration?.canCreateConfig === true) {
          panelBody.push(el('div', { key: 'cfgRow', className: 'lfh-panel-row' },
            badge(t('panel.config.env'), 'ok'),
            el('code', { className: 'lfh-panel-code' }, String(voluntary.configPath || ''))));
          panelBody.push(el('div', { key: 'cfgEnvNote', className: 'lfh-panel-note' },
            t('panel.config.envNote', { host: String(data.migration?.env?.baseUrlHost || '') })));
        } else {
          panelBody.push(el('div', { key: 'cfgRow', className: 'lfh-panel-row' },
            badge('config.json', 'bad'),
            el('code', { className: 'lfh-panel-code' }, String(voluntary.configPath || ''))));
          panelBody.push(el('div', { key: 'cfgMissing', className: 'lfh-panel-warn' },
            t('panel.config.missing', { path: String(voluntary.configPath || '') })));
          const missingEnv = Array.isArray(data.migration?.missingEnv) ? data.migration.missingEnv : [];
          if (missingEnv.length > 0) {
            panelBody.push(el('span', { key: 'cfgEnvMissing', className: 'lfh-panel-note' },
              t('panel.config.envMissing', { fields: missingEnv.join(', ') })));
          }
        }
        panelBody.push(el('div', { key: 'modRow', className: 'lfh-panel-row' },
          badge(String(voluntary.modulePresent === true ? t('panel.module.present') : t('panel.module.vendor')),
            voluntary.modulePresent === true ? 'ok' : '')));

        if (migrationAvailable) {
          panelBody.push(el('div', { key: 'migHead', className: 'lfh-panel-section' }, t('panel.migration.title')));
          panelBody.push(el('span', { key: 'migDesc', className: 'lfh-panel-note' }, t('panel.migration.desc')));
          if (data.migration?.canCreateConfig === true) {
            panelBody.push(el('div', { key: 'migEnv', className: 'lfh-panel-note' }, t('panel.migration.envNote')));
          }
          if (applyState.phase === 'idle') {
            panelBody.push(el('div', { key: 'migActions', className: 'lfh-panel-actions' },
              el('button', { type: 'button', className: 'lfh-panel-primary', onClick: requestApply }, t('panel.migration.button'))));
          } else if (applyState.phase === 'confirm') {
            panelBody.push(el('div', { key: 'migConfirm', className: 'lfh-panel-warn' },
              el('strong', { className: 'lfh-panel-line' }, t('panel.migration.confirmTitle')),
              el('span', { className: 'lfh-panel-line' }, t('panel.migration.confirmDesc'))));
            panelBody.push(el('div', { key: 'migActions', className: 'lfh-panel-actions' },
              el('button', { type: 'button', className: 'lfh-panel-btn', onClick: cancelApply }, t('panel.migration.cancel')),
              el('button', { type: 'button', className: 'lfh-panel-primary', onClick: () => { void confirmApply(); } }, t('panel.migration.confirm'))));
          } else if (applyState.phase === 'applying') {
            panelBody.push(el('span', { key: 'migRunning', className: 'lfh-panel-note' }, t('panel.migration.running')));
          } else if (applyState.phase === 'error') {
            panelBody.push(el('span', { key: 'migError', className: 'lfh-panel-bad' },
              t('panel.migration.failed', { error: String(applyState.error || '') })));
            panelBody.push(el('div', { key: 'migRetry', className: 'lfh-panel-actions' },
              el('button', { type: 'button', className: 'lfh-panel-btn', onClick: refreshPanel }, t('panel.refresh'))));
          } else if (applyState.phase === 'done') {
            const result = applyState.result ?? {};
            const status = String(result.status || '');
            let resultText = t('panel.migration.failed', { error: String(result.error?.message || result.error?.code || '') });
            let resultTone = 'bad';
            if (status === 'applied') { resultText = t('panel.migration.applied'); resultTone = 'ok'; }
            else if (status === 'already') { resultText = t('panel.migration.already'); resultTone = 'ok'; }
            else if (status === 'applied_restart_required') { resultText = t('panel.migration.partial'); resultTone = 'warn'; }
            else if (status === 'restart_required') { resultText = t('panel.migration.restart'); resultTone = 'warn'; }
            panelBody.push(el('div', { key: 'migResult', className: `lfh-panel-${resultTone}` }, resultText));
            if (typeof result.configCreated === 'string' && result.configCreated.length > 0) {
              panelBody.push(el('code', { key: 'migConfigCreated', className: 'lfh-panel-code' },
                t('panel.migration.configCreated', { path: result.configCreated })));
            }
            const backups = Array.isArray(result.backups) ? result.backups : [];
            if (backups.length > 0) {
              panelBody.push(el('code', { key: 'migBackups', className: 'lfh-panel-code' },
                t('panel.migration.backups', { paths: backups.join(' ; ') })));
            }
            const changed = Array.isArray(result.changed) ? result.changed : [];
            if (changed.length > 0) {
              panelBody.push(el('code', { key: 'migChanged', className: 'lfh-panel-code' },
                t('panel.migration.changed', { paths: changed.join(' ; ') })));
            }
            panelBody.push(el('div', { key: 'migAgain', className: 'lfh-panel-actions' },
              el('button', { type: 'button', className: 'lfh-panel-btn', onClick: refreshPanel }, t('panel.refresh'))));
          }
        } else if (data.migration?.reason === 'config_missing') {
          panelBody.push(el('div', { key: 'cfgWarn', className: 'lfh-panel-warn' }, t('panel.migration.configMissing')));
        }
      }
      // Connection config editor. It is built here but only mounted while the
      // panel is open, and the status query runs only from openPanel/retry, so
      // the form never expands or submits on page load.
      const configNodes = [];
      configNodes.push(el('div', { key: 'cfgTitle', className: 'lfh-panel-section' }, t('panel.config.title')));
      configNodes.push(el('span', { key: 'cfgDesc', className: 'lfh-panel-note' }, t('panel.config.desc')));
      if (config.phase === 'loading' || config.phase === 'idle') {
        configNodes.push(el('span', { key: 'cfgLoading', className: 'lfh-panel-note' }, t('panel.config.loading')));
      } else if (config.phase === 'error') {
        configNodes.push(el('span', { key: 'cfgLoadError', className: 'lfh-panel-bad' },
          t('panel.config.loadError', { error: String(config.error || '') })));
        configNodes.push(el('div', { key: 'cfgRetry', className: 'lfh-panel-actions' },
          el('button', { type: 'button', className: 'lfh-panel-btn', onClick: () => { void loadConfig(); } }, t('panel.refresh'))));
      } else if (config.status !== null) {
        const status = config.status;
        const uploader = status.uploader !== null && typeof status.uploader === 'object' ? status.uploader : {};
        const installed = uploader.installed === true;
        const saving = configSave.phase === 'saving';
        configNodes.push(el('div', { key: 'cfgStateRow', className: 'lfh-panel-row' },
          badge(t(status.valid === true ? 'panel.config.state.valid' : 'panel.config.state.invalid'), status.valid === true ? 'ok' : 'bad'),
          status.ready === true ? badge(t('panel.config.state.ready'), 'ok') : null));
        if (typeof status.path === 'string' && status.path.length > 0) {
          configNodes.push(el('code', { key: 'cfgPath', className: 'lfh-panel-code' },
            t('panel.config.path', { path: status.path })));
        }
        configNodes.push(el('span', { key: 'cfgKeys', className: 'lfh-panel-note' },
          t('panel.config.keys', {
            public: configKeyText(t, status.publicKeySet === true, status.publicKeyHint),
            secret: configKeyText(t, status.secretKeySet === true, null),
          })));
        configNodes.push(el('span', { key: 'cfgDefaultOff', className: 'lfh-panel-note' }, t('panel.config.defaultOff')));
        if (status.valid === true && status.ready !== true && installed) {
          configNodes.push(el('span', { key: 'cfgPending', className: 'lfh-panel-note' }, t('panel.config.state.pending')));
        }

        configNodes.push(el('div', { key: 'upHead', className: 'lfh-panel-section' }, t('panel.config.uploader.title')));
        configNodes.push(el('div', { key: 'upRow', className: 'lfh-panel-row' },
          badge(t(installed ? 'panel.config.uploader.installed' : 'panel.config.uploader.missing'), installed ? 'ok' : 'bad'),
          installed
            ? badge(t(uploader.active === true ? 'panel.config.uploader.active' : 'panel.config.uploader.inactive'),
              uploader.active === true ? 'ok' : 'warn')
            : null));
        if (!installed) {
          if (configInstall.phase === 'running') {
            configNodes.push(el('span', { key: 'upRunning', className: 'lfh-panel-note' }, t('panel.config.uploader.installing')));
          } else {
            configNodes.push(el('div', { key: 'upActions', className: 'lfh-panel-actions' },
              el('button', { type: 'button', className: 'lfh-panel-primary', onClick: () => { void installConfigUploader(); } },
                t('panel.config.uploader.install'))));
          }
        }
        if (configInstall.phase === 'done' && installed) {
          configNodes.push(el('span', {
            key: 'upDone',
            className: configInstall.restartRequired ? 'lfh-panel-warn' : 'lfh-panel-ok',
          }, t(configInstall.restartRequired ? 'panel.config.uploader.restart' : 'panel.config.uploader.installedOk')));
        } else if (configInstall.phase === 'error') {
          configNodes.push(el('span', { key: 'upError', className: 'lfh-panel-bad' },
            t('panel.config.uploader.failed', { error: configErrorText(t, String(configInstall.error || '')) })));
        }

        /**
         * Render one labeled input and its field-scoped save error.
         * @param {string} key - form field id.
         * @param {{ type?: string, placeholder?: string, autoComplete?: string, min?: string, max?: string }} [options] - input overrides.
         * @returns {any} React element.
         */
        const fieldNode = (key, options = {}) => {
          const fieldError = configSave.phase === 'error' && configSave.field === key
            ? configFieldErrorText(t, key, String(configSave.reason || ''))
            : null;
          const children = [
            el('span', { key: `label-${key}`, className: 'lfh-field-label' }, t(`panel.config.field.${key}`)),
            el('input', {
              key: `input-${key}`,
              id: `lfh-config-${key}`,
              className: 'lfh-input',
              type: options.type ?? 'text',
              value: configForm[key],
              placeholder: options.placeholder,
              disabled: saving,
              autoComplete: options.autoComplete ?? 'off',
              spellCheck: false,
              min: options.min,
              max: options.max,
              'aria-invalid': fieldError === null ? undefined : 'true',
              onChange: event => {
                const value = event.target.value;
                setConfigForm(previous => ({ ...previous, [key]: value }));
                setConfigSave(previous => (previous.phase === 'saving' || previous.phase === 'idle'
                  ? previous
                  : { phase: 'idle', field: null, reason: null, error: null }));
              },
            }),
          ];
          if (fieldError !== null) {
            children.push(el('span', { key: `error-${key}`, className: 'lfh-field-error' }, fieldError));
          }
          return el('label', { key: `field-${key}`, className: 'lfh-field' }, ...children);
        };
        const publicPlaceholder = status.publicKeySet === true
          ? t('panel.config.placeholder.publicKey.set', { hint: String(status.publicKeyHint || t('panel.config.key.set')) })
          : t('panel.config.placeholder.publicKey.unset');
        const secretPlaceholder = status.secretKeySet === true
          ? t('panel.config.placeholder.secretKey.set')
          : t('panel.config.placeholder.secretKey.unset');
        configNodes.push(el('div', { key: 'cfgForm', className: 'lfh-config-form' },
          fieldNode('baseUrl', { type: 'url', autoComplete: 'url', placeholder: t('panel.config.placeholder.baseUrl') }),
          fieldNode('publicKey', { placeholder: publicPlaceholder }),
          fieldNode('secretKey', { type: 'password', autoComplete: 'new-password', placeholder: secretPlaceholder }),
          fieldNode('userId', { placeholder: t('panel.config.placeholder.userId') }),
          fieldNode('maxChars', { type: 'number', min: '1', max: '20000', placeholder: t('panel.config.placeholder.maxChars') }),
          el('span', { key: 'cfgHint', className: 'lfh-panel-note' }, t('panel.config.hint')),
          el('div', { key: 'cfgActions', className: 'lfh-panel-actions' },
            el('button', {
              type: 'button',
              className: 'lfh-panel-primary',
              disabled: saving,
              onClick: () => { void saveConfigForm(); },
            }, t(saving ? 'panel.config.saving' : 'panel.config.save'))),
          configSave.phase === 'saved'
            ? el('div', { key: 'cfgSaved', className: 'lfh-panel-ok' }, t('panel.config.saved'))
            : null,
          configSave.phase === 'error' && configSave.field === null
            ? el('span', { key: 'cfgSaveError', className: 'lfh-panel-bad' },
              t('panel.config.saveFailed', { error: configErrorText(t, String(configSave.error || '')) }))
            : null,
        ));
      }
      panelBody.push(el('div', { key: 'configEntry', className: 'lfh-config' }, ...configNodes));

      panelBody.push(el('span', { key: 'closeHint', className: 'lfh-panel-note' }, t('panel.migration.closeHint')));

      return createElement(
        React.Fragment,
        null,
        createElement('style', { key: 'style' }, CSS),
        createElement(
          'span',
          {
            key: 'root',
            ref: rootRef,
            className: 'lfh-root',
            onPointerEnter: openTipSoon,
            onPointerLeave: closeTipHover,
            onKeyDown: (event) => {
              if (event.key === 'Escape' && (showTip || panelOpen)) {
                event.stopPropagation();
                closeTipHover();
                setPanelOpen(false);
              }
            },
          },
          // Left target: the plugin interface. Opens the hook scan panel and
          // never changes consent.
          createElement(
            'button',
            {
              type: 'button',
              className: 'lfh-label',
              'aria-label': t('details.aria'),
              'aria-haspopup': 'dialog',
              'aria-expanded': panelOpen ? 'true' : 'false',
              'aria-describedby': showTip ? hintId : undefined,
              onClick: openPanel,
              onFocus: openTipNow,
              onBlur: closeTipHover,
            },
            createElement('span', { className: 'lfh-long' }, t('label.title')),
            createElement('span', { className: 'lfh-short', 'aria-hidden': 'true' }, t('label.titleShort')),
          ),
          // Right target: the only control that changes consent.
          createElement(
            'button',
            {
              type: 'button',
              role: confirmed ? 'switch' : 'button',
              'aria-checked': confirmed ? (view.enabled ? 'true' : 'false') : undefined,
              'aria-busy': busy ? 'true' : undefined,
              'aria-disabled': busy ? 'true' : undefined,
              'aria-label': confirmed ? t('aria.switch') : t('aria.unknown'),
              'aria-describedby': showTip ? hintId : undefined,
              className: 'lfh-switch',
              'data-state': stateKey,
              onClick: () => { if (!busy) onActivate(); },
              onFocus: openTipNow,
              onBlur: closeTipHover,
            },
            createElement('span', { className: 'lfh-state' }, stateLabel),
            createElement(
              'span',
              { className: 'lfh-track', 'aria-hidden': 'true' },
              createElement('span', { className: 'lfh-knob' }),
            ),
          ),
          createElement('span', { className: 'lfh-sr', role: 'status', 'aria-live': 'polite' }, fullLabel),
          showTip
            ? ReactDOM.createPortal(
              createElement(
                'div',
                { key: 'tip', id: hintId, role: 'tooltip', className: 'lfh-tip', style: tipStyle },
                ...lines,
              ),
              document.body,
            )
            : null,
          panelOpen
            ? ReactDOM.createPortal(
              el(
                'div',
                {
                  key: 'panel',
                  ref: panelRef,
                  role: 'dialog',
                  'aria-label': t('panel.title'),
                  className: 'lfh-panel',
                  style: panelStyle,
                },
                el(
                  'div',
                  { className: 'lfh-panel-head' },
                  el('span', { className: 'lfh-panel-title' },
                    t('panel.title'),
                    el('span', { className: 'lfh-panel-sub' }, t('panel.subtitle'))),
                  el('button', {
                    type: 'button',
                    className: 'lfh-panel-btn',
                    onClick: refreshPanel,
                    disabled: scan.phase === 'loading',
                  }, t('panel.refresh')),
                  el('button', {
                    type: 'button',
                    className: 'lfh-panel-btn lfh-panel-close',
                    'aria-label': t('panel.close'),
                    onClick: () => { setPanelOpen(false); },
                  }, '×'),
                ),
                el('div', { className: 'lfh-panel-body' }, ...panelBody),
              ),
              document.body,
            )
            : null,
        ),
      );
    }

    /**
     * Client plugin entry: register the dictionaries and the header cell.
     * @param {any} ctx - Cordis Client context with `slots`, `connection`, and `locale`.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-langfuse-header-toggle: dictionaries');

      // Connection generation changes mean the Host was restarted or the wire
      // recovered: every visible state may be stale, so refresh the header.
      const connectionListeners = new Set();
      ctx.effect(() => {
        const unsubscribe = ctx.connection.generation.subscribe(() => {
          for (const listener of [...connectionListeners]) {
            try {
              listener();
            } catch {
              // One header failing must not block the others.
            }
          }
        });
        return () => {
          unsubscribe();
          connectionListeners.clear();
        };
      }, 'dsh-langfuse-header-toggle: connection generation listeners');

      ctx.slots.inject('conversation.session.header.actions', () => {
        // One stable inject face per registration lifetime: the component's
        // refresh effect depends on these function identities.
        const injected = {
          queryUpload: sessionId => postJson(ROUTES.state, { sessionId }),
          setUpload: (sessionId, enabled) => postJson(ROUTES.set, { sessionId, enabled }),
          subscribeConnection: (listener) => {
            connectionListeners.add(listener);
            return () => { connectionListeners.delete(listener); };
          },
        };
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'langfuse-upload',
          // Sits after the preset label's negative-order band (-10) and before
          // the transient job list (20), directly right of the Session title.
          order: 0,
          locale: NS,
          inject: () => injected,
        }, UploadToggle);
      });
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply,
      // Pure helpers exposed for offline tests of the stale-answer guard, the
      // "unknown instead of false" normalization, the split-control structure,
      // and the route table.
      __internals: {
        createAnswerGate,
        normalizeResult,
        errorText,
        failureDetail,
        postJson,
        UploadToggle,
        ROUTES,
        NS,
        configStatusOf,
        configFormFromStatus,
        configFieldErrorText,
        configErrorText,
      },
    };
  },
});
