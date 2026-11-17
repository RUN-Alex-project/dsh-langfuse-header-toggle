# dsh-langfuse-header-toggle

DeepSeek Harness（DSH）顶部栏的「**本会话上传到 Langfuse**」开关插件：把现有 `/lf on`、`/lf off`、`/lf off-all` 命令的逐会话授权，做成标题右侧一个始终看得见、点一下就能用的开关；同一面板里还提供 **Langfuse 连接配置**与上传器安装入口。

| 项目 | 值 |
| --- | --- |
| 插件包名 | `@local/dsh-langfuse-header-toggle` |
| 版本 | 1.2.0 |
| 目标 DSH | Desktop **0.2.2-rc.3**（profile `desktop`，`<DSH 安装目录>` 安装） |
| 依赖的现有上传器 | `dsh-langfuse-voluntary` **1.0.2**（`%USERPROFILE%\.dsh\langfuse-voluntary\dsh-langfuse-voluntary-1.0.2.mjs`；在 1.0.1 基础上新增 `/lf on --history`，采集/上传逻辑未变） |
| 安装方式 | 本地目录 Bundle，`plugin_manager` / 插件页「添加插件」，已热加载 |
| 安装位置 | 本目录（`...\outputs\dsh-langfuse-header-toggle`），以 `link:` 方式挂进 desktop profile |
| 安装日期 | 2026-11-16 |
| 验证记录 | 实际界面截图、审计日志与 Langfuse 查询结果只保留在本地（含会话内容），未随仓库发布 |

> 本目录**不包含** Langfuse 地址、公钥或私钥。密钥仍只保存在原上传器的私有 `config.json` 中，前端与插件代码都拿不到。

---

## 1. 开关在哪里

会话标题右侧、模式标签之后、后台任务列表之前。按你的要求，控件是**左右两个独立目标**：

```
会话标题   标准模式   本会话上传  关 ⬤      1 个后台任务        …    ☐
                  ^^^^^^^^^^  ^^^^^^
                  左：只看详情   右：开关（唯一能切换的地方）
```

- **左侧「本会话上传」**：点击只打开/收起详情卡片（当前状态、隐私说明、发送统计），**绝不会切换开关**；鼠标悬停或键盘聚焦也会显示详情，按 Esc 或点击空白处关闭。
- **右侧状态文字 + 拨动开关**：只有这里点击才会切换。
  - 关闭：灰轨道 + `关`；开启：绿轨道 + 绿字 `开`（文字颜色经对比度修正）
  - 查询中 / 处理中：`查询中` / `处理中`，开关禁用并防止连点
  - 无法确认后台状态：红轨道 + `状态未知`（**不会**伪装成「关」）；此时点右侧只会重新查询，不会授予权限
- 详情卡片包含：当前状态、`仅上传开启后新开始的轮次……已上传内容无法撤回`、仅本会话生效、本次进程已确认接收/失败轮数、`开=已授权、不代表每次发送成功`，以及出错原因与重试说明。
- 窗口较窄（会话列宽 ≤ 560px）时左侧名称简写为 `上传`，右侧状态文字与开关仍完整保留。
- 无障碍：左侧是 `button`（`aria-expanded` 详情、`aria-label` 明确“不会切换”）；右侧在确认态是 `role="switch"` + `aria-checked`，未知态降级为 `button` 并提示“状态未知，按下重新查询”；`aria-live` 播报状态变化，`aria-disabled` 保证操作中不丢焦点，支持 reduced-motion。

## 1.1 插件界面：上传钩子扫描与迁移（1.1.0）

点击左侧「本会话上传」打开**上传钩子状态**面板（每次打开都会重新扫描一次，不缓存旧结果）：

- **结论**：可控 / 不可控 / 可迁移 / 待加载 / 未安装；
- **检测到的上传钩子**：Loader 条目 id、模块路径、类型（自愿上传 / 自动采集 / 其他 Langfuse 插件）、是否运行、是否有开关；
- **运行时**：DSH 版本、profile、自愿上传器版本与就绪状态；
- **配置**：`~/.dsh/langfuse-voluntary/config.json` 是否存在、自愿上传器模块是否存在（只显示路径，不显示密钥内容）；
- **迁移**：当检测到**原版自动采集**、且没有运行中的自愿上传器时，出现「应用：改为自愿上传」按钮。
- **配置来源**：优先用已有的 `config.json`；如果没有，但原版采集启动时的 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASEURL`（或 `LANGFUSE_HOST`）/ `LANGFUSE_USER_ID` 环境变量齐全，则应用时会**自动生成** `config.json`（密钥只在 Host 侧写入，浏览器只看到“可用/缺失”布尔值，拿不到密钥）。

**首次安装（机器上是原版自动采集）的操作顺序：**

1. 安装本插件（插件页或 `install_bundle`），插件会自动加载；
2. 点击会话标题右侧的「本会话上传」打开面板；
3. 面板会显示原版钩子、DSH 版本、配置来源；若显示「可迁移」，点「应用：改为自愿上传」，再「确认应用」；
4. 若结果提示「需要重启 DSH」，重启后再打开面板确认显示「可控 / 有开关」；之后每个会话默认关闭，需要上传时再打开开关。

如果面板显示「config.json 缺失」且没有可用的 `LANGFUSE_*` 环境变量（例如 DSH 启动时没有带上原版采集的环境变量），把 `vendor/config.example.json` 复制到 `%USERPROFILE%\.dsh\langfuse-voluntary\config.json` 并填好 `baseUrl/publicKey/secretKey/userId`（工号），重新扫描即可。

点击「应用」是两段式：先展示将执行的动作（备份 → 移除原版自动采集行 → 写入默认关闭的自愿上传行 → 等待热加载，必要时提示重启），再点「确认应用」才执行。安全约束：

- 先备份，再改写；备份路径会显示在结果里（`~/.dsh/langfuse-voluntary/backups/`）；
- 使用带 BEGIN/END 标记的管理块，幂等，可重复执行；
- 只要配置里仍有原版采集行，迁移会拒绝执行并报告，不会写一半；
- `config.json` 缺失时按钮不出现，只显示缺失提示（不会偷偷移除原版采集）；
- 写入后 8 秒内检测自愿上传器是否加载：完全生效显示「迁移完成」，原版仍在运行或未加载则明确提示「需要重启 DSH」；
- 扫描/迁移都不发送任何 OTLP、不进模型上下文；迁移只写 profile 的 `cordis.patch.yml`（和存在时的 `~/.dsh/cordis.patch.yml`）文件。

> 注意：迁移只处理 **DSH Loader** 里的上传钩子。原版 oh-langfuse 还可能通过 Codex 的 Python hook 上报（不在 DSH 内），那部分不会被自动处理，面板也不会误报成已清理。

## 1.2 安装后配置（1.2.0）

1.2.0 起不再需要手工创建 `config.json`，也不需要手工往 Loader 里加行——在插件自己的面板里填写即可：

1. 点击会话标题右侧的「本会话上传」打开面板，找到「**Langfuse 连接配置**」区域（表单只在打开面板后出现，页面加载时不会展开、也不会自动提交）；
2. 填写字段：
   - `baseUrl`：Langfuse 地址，必须是纯 origin（如 `https://langfuse.example.com`；不能带路径、用户名或密码）；
   - `publicKey`：`pk-lf-` 开头；
   - `secretKey`：`sk-lf-` 开头；输入框是密码类型，已保存的值**永远不会回填**浏览器，留空表示保持原值；但**更换 `baseUrl`（origin 变化）时必须重新填写**，避免旧密钥被带到另一个主机；
   - `userId`：工号，格式如 `j60000000`；
   - `maxChars`：可选，默认 20000，超过 20000 按 20000 保存；
3. 点「保存配置」。Host 用与上传器 `loadConfig()` 相同的规则逐字段校验，失败时按 `{ code: 'invalid_config', details: { field, reason } }` 返回并在对应输入框下显示中文原因；成功后以「临时文件 + rename」原子替换 `<DSH home>/langfuse-voluntary/config.json`（POSIX 下 `0600`，Windows 上尽力而为）；
4. 若面板显示「上传器未安装」，点「安装上传器」：Host 先把内置的 1.0.2 模块复制到 `<DSH home>/langfuse-voluntary/`（目标已存在且内容一致则跳过），再用受管块把自愿上传行写入 profile 的 `cordis.patch.yml`（写前备份到 `<DSH home>/langfuse-voluntary/backups/`，命名沿用迁移流程），最多等 8 秒观察 `locateUploader()`/`scanHooks()`；返回 `restartRequired: true` 时按提示重启 DSH。

**默认关闭语义（配置 ≠ 开启上传）**：`save` 与 `install` 都**不会**调用上传器的 `command()`/`set()`，也不会改变任何会话的授权状态；两者返回的状态都带 `defaultOff: true`。配置只决定上传器能否连接 Langfuse，是否上传仍由每个会话的开关（或 `/lf on`）单独决定，且所有会话默认关闭。保存成功后面板明确显示「已保存，仍默认关闭：配置不会开启任何会话的上传，需要时按会话点开关」。

**脱敏**：浏览器只能拿到 `publicKeySet`/`secretKeySet` 布尔值和 `publicKeyHint`（如 `pk-lf-…1a2b`，只露末 4 位）；完整 `publicKey` 与 `secretKey` 从不返回，校验错误信息也不回显密钥值。

**为什么保存后可能还要重启**：上传器只在模块加载时读取一次 `config.json`。如果它早已运行（无论此前是否加载过有效配置），保存了不同内容后状态会显示「上传器尚未读取该配置，重启 DSH 后生效」；只有保存内容与当前文件完全一致时才继续显示「上传器已读取配置」。这是如实报告，不是保存失败。

**不会重复迁移**：若仍检测到原版自动采集行（`dsh-langfuse` / `dsh-langfuse-telemetry`，无论来自 Loader 条目还是 patch 文本），`install` 会拒绝（`auto_collector_present`）并提示改用 1.1 的「迁移为自愿上传」流程，不会重复实现迁移。

## 2. 与 `/lf` 命令的关系

**同一个状态机，同一个后端**。开关只是现有上传器授权状态的图形入口：

| 操作 | 顶部开关 | 结果 |
| --- | --- | --- |
| 输入 `/lf on` | 4 秒内自动变为「开」 | 仅当前会话开启 |
| 输入 `/lf off` | 自动变为「关」 | 当前会话关闭并清空未提交缓存 |
| 输入 `/lf off-all` | 已挂载的页头自动变为「关」 | 进程内全部会话关闭 |
| 输入 `/lf on --history` | 4 秒内自动变为「开」，并在下一条消息时补传历史 | 仅当前会话，见 2.2 |
| 点击开关 | 直接调用确定的后端能力（不经过模型推理，不消耗模型调用） | 与命令完全一致 |

## 2.1 对话进行中点击开关，会上传吗？

**不会上传“当前这一轮”。** 规则始终是：开关只决定“状态确定之后**新开始**的轮次”。

- **在某一轮进行中点“开”**：上传器在开启瞬间记录会话当前事件位置（`fromSeq`），只对这个位置之后**新开始**的轮次建立缓冲。正在进行的这一轮，其 `turn/start` 早于该位置，整轮被跳过，结束后也不会补传。（已在验证中实测：新会话 turn 1 运行中开启，turn 1 结束后审计日志无 `sent`；随后新 turn 2 才上传。）
- **在某一轮进行中点“关”**：该轮若是在开启之后才开始的，尚未提交的内容会被清空、在途请求会被尝试中止，不会上传；但若数据**已经被服务端接收**，则无法撤回（这也是详情卡片里写明“已上传内容无法撤回”的原因）。
- **历史内容**：默认不扫描、不补传开启前的历史轮次；如需显式补传，见 2.2 的 `/lf on --history`。
- 极端并发时序（轮次恰好在同一瞬间结束并发起上传）可能同时发生，实际以 `control-events.jsonl` 的 `sent/failed` 为准；正常手动点击不会撞上这个窗口。

## 2.2 补传开启前的历史：`/lf on --history`

默认行为不变：`/lf on` 只上传此后新开始的轮次，历史内容不扫描、不补传。

如果确实需要把「开启前已完成的对话」一起上传，用显式命令：

```
/lf on --history
```

- 开启瞬间读取本会话**已完成**的历史轮次（正在进行的轮次不算），暂存待传；
- **下一条消息开始时**触发补传：每个历史轮次生成一个 trace，然后当前这条消息照常上传；
- 命令返回会写明「将在下一条消息开始时补传此前 N 个历史轮次」；`/lf status` 显示「历史补传：待补传 N 轮」；
- `/lf off`、`/lf off-all` 或上传器重载会清空待补传内容；
- 只对当前会话生效；历史内容一旦发送无法撤回；
- 普通 `/lf on` 不会暂存任何历史。

## 3. 隐私与授权边界（实现方式即保证）

1. **默认关闭**：上传器只在收到显式 `on` 后才采集；桥接层把「查询不到状态」一律报告为关。
2. **仅当前会话**：状态按精确 `sessionId` 读写；A 开启不影响 B，切到 B 也不会自动关闭 A。
3. **新会话 / 派生 / fork 不继承**：上传器状态以会话 id 为键，全新 id 从关开始；桥接层只接受 `ctx.sessions` 中真实存在的活动会话。
4. **重启 / 上传器重载后全部关闭**：授权只存在进程内存；实测上传器插件重载后页头恢复「关」。
5. **默认只上传开启后新开始的轮次**：开启时由上传器记录当时的事件 `seq`；默认不扫描、不补传历史。唯一例外是显式执行 `/lf on --history`：只暂存开启前已完成的轮次，并在下一条消息开始时补传（见 2.2）；进行中的轮次、其它会话、未开启时的内容都不会被读取。
6. **关闭即清理**：关闭会清空尚未提交的文本/轮次缓存并中止在途请求；已发送到服务端的数据无法撤回（tooltip 已说明）。
7. **不落地待上传正文**：关闭期间不缓存对话正文，不在退出时补发，没有后台队列或自动重试。
8. **前端无密钥**：浏览器只收到 `{enabled, ready, version, sent, failed, last}` 这类状态；连接配置也只返回布尔值、末 4 位提示和明文非密钥字段（`baseUrl`/`userId`/`maxChars`），完整公钥与私钥从不返回。真正上传仍由 Host 侧原上传器执行。
9. **不新增控制端口**：五个接口（state/set/scan/migrate/config）都是 DSH 现有 `/api` 共享通道上的精确路由，复用 DSH 的 Host/Origin 校验和浏览器 Cookie 认证，且仅 owner Peer 可达。
10. **不改 token 口径、不改度量平台成员资料**：全部沿用现有上传器的逻辑。
11. **开关不是「假开关」**：切换直接作用于上传器授权状态；关闭后上传器自己不再采集、不再发送。

## 4. 实现结构

```
浏览器（client.js）
  └─ slot: conversation.session.header.actions（order 0，会话作用域，props 自带 sessionId）
       ├─ 挂载/切换会话时立即查询；轮询 4s；窗口聚焦、标签可见、Connection 代际变化时刷新
       ├─ 左侧名称打开扫描面板：每次打开 POST scan 与 config(get)；确认后 POST migrate（两段式）；保存配置 POST config(save)；安装上传器 POST config(install)
       ├─ createAnswerGate：丢弃「其它会话的迟到响应」「被新查询/新操作覆盖的响应」
       └─ POST api/dsh-langfuse-toggle/state | set | scan | migrate | config   （同源 Cookie，JSON）
                                   │
DSH Host（index.js，Cordis 插件）
       └─ connection.fetch.register 五条 /api 精确路由
            ├─ 由 DSH 现有 /api 通道完成 Host/Origin 校验 + 浏览器认证 + owner Peer 限制
            ├─ state/set：createBridge 读 diagnostics()、转发 command()（不采集/不上传）
            ├─ scan：ctx.loader.entries() 枚举上传钩子 + 文件存在性 + 运行时诊断符号（只读）
            ├─ migrate：备份 → 移除原版采集行 → 写入自愿行管理块 → 等待加载 → 报告是否需重启
            └─ config：get 读取脱敏状态；save 逐字段校验后原子写 config.json；install 复制内置模块 + 写受管 Loader 行 + 备份（三者都不调用 command()，默认关闭）
                                   │
现有上传器 dsh-langfuse-voluntary 1.0.2（1.0.1 + `/lf on --history`；采集/上传逻辑未变）
       └─ 原有采集/缓存/OTLP 上传/`/lf` 命令/`off-all`/审计日志
```

- **没有第二套采集/缓存/上传逻辑**：插件自己不保存对话正文、不发送任何 OTLP。
- 桥接层通过上传器已公开的 `globalThis[Symbol.for('dsh.langfuse.voluntary')]` 诊断入口找到运行时控制器；上传器重载后下一次请求会自动使用新实例。
- 读状态用 `diagnostics()`；写授权复用上传器自己的 `command()`（与 `/lf` 完全相同的一段代码路径），因此 `/lf` 与开关不可能出现两套状态。
- 为什么不用 `connection.rpc.handle()`：该注册器内部通过 Connection 服务自身的 ctx 访问 `webServer`，而该 ctx 只声明了 `credentials` 依赖，第三方插件调用会抛 `cannot get property "webServer" without inject`（0.2.2-rc.3 实测）；`connection.rpc.intercept('/api', …)` 是单所有者插槽且已被 API Gateway 占用。`connection.fetch.register` 是同一认证通道上官方提供的另一入口，无需额外依赖，因此选择它。

## 5. 安装

前提：DSH Desktop 0.2.2-rc.3 正在运行。若机器上已有 `dsh-langfuse-voluntary` 1.0.2 并 active，开关装好即可用；若还没有配置或上传器，装好本插件后打开面板，按 1.2 节填写连接配置并点「安装上传器」；若还是原版自动采集，按 1.1 节的面板迁移（可自动从 `LANGFUSE_*` 环境变量生成配置）。

方式 A（界面）：**插件 → 添加插件 → 本地目录**，选择本目录。
方式 B（命令）：
```
plugin_manager action=install_bundle target=<本仓库>
```

安装结果（已实测）：
- desktop profile `package.json` 的 `dsh.profile.bundles` 末尾增加 `@local/dsh-langfuse-header-toggle`，`dependencies` 增加 `link:` 指向本目录；
- Loader 新增 `include:dsh-langfuse-header-toggle`（active）；
- 浏览器端模块热加载，页面无需重启即出现开关（若未出现，刷新一次页面即可）。

卸载/停用见第 8 节。

## 6. 已验证的内容（摘要）

详细证据、时间与截图只保留在本地，未随仓库发布；下表中的 `v*.png` 是本地截图文件名。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| A 新会话默认关、关闭时不上传 | ✅ | `v5-turn1.png`（首轮完成仍显示关），上传器日志无该会话的 `on/sent` |
| B 点击开启→上传入库→点击关闭→停止上传 | ✅ | `v6-toggle-on.png`、`v7-turn2-uploaded.png`；日志 `on` + `sent(turn 2, http 200)`；`langfuse-query-1.json` 服务端可查到 trace；`v9-toggle-off.png` + 之后无新 `sent` |
| C 会话隔离、迟到响应不串会话 | ✅（隔离）/✅（迟到响应：离线单测） | `v14-sessionB-off.png`（A 开、B 关）、`v15-back-to-A-on.png`（切回 A 仍开） |
| D 命令与开关同步（on/off/off-all） | ✅ | `v12-cmd-on-result.png`、`v13-cmd-off-result.png`、`v16-off-all.png` |
| E 查询失败显示未知并可恢复 | ✅ | `v17-uploader-down-unknown.png`（上传器停用时红色「状态未知」）、`v18b-recovered.png`（恢复后自动回到「关」） |
| E 操作失败不假报成功 | ✅（离线单测） | `tests/bridge.test.mjs` 覆盖 `uploader_refused`、`state_not_confirmed`；前端把非确认结果归一为「状态未知」 |
| F 上传器重载/插件卸载后的清理 | ✅ | 上传器重载后 `v18b`；卸载 Bundle 后控件消失 `v19/v23`；重装后恢复 `v20/v24` |
| 快速连点不重复 | ✅ | `v21-doubleclick.png`：两次快速点击=一次开+一次关，日志无重复 `on`/`sent` |
| 服务端入库确认 | ✅ | 三次 trace 均用 Langfuse 读接口按 traceId 查到，`userId=xxxxxxxx`、`sessionId` 匹配、`turn_number=2/3/2`、`voluntary_upload=true` |
| **新会话复测（修复后，只在全新会话开启）** | ✅ | 新会话 `session-9162c50e…`：默认关 → 开启 → 进行中的 turn 1 按设计不上传 → 空闲后新 turn 2 上传（服务端可查 `langfuse-query-3.json`）→ 关闭；tooltip 显示“已确认接收 1 轮”。旧会话全程未被开启 |
| 界面窄宽度 | ✅（右侧栏展开时实测简写标签） | `raw/v4-turn1-debug.png`（修复前）与 `v38`（修复后为「会话上传：关」） |
| 开关提示隐私边界 | ✅ | `v8-tooltip-on.png`（修复前）、`v33/v38`（修复后深色 tooltip：目的地 Langfuse、发送统计、“开≠每次发送成功”） |
| 开关操作不消耗模型调用 | ✅ | 切换前后会话「轮/步」与 token 统计不变，日志也无模型请求 |
| 上传钩子扫描面板 | ✅ | `v52-panel-open.png`、`v53-panel-fixed.png`：每次打开重新扫描，显示「可控 / 自愿上传 / 运行中 / 有开关」、DSH 0.2.2-rc.3 · profile desktop、config.json 已就绪；打开面板不影响开关状态（日志无变化） |
| 迁移为自愿上传 | ✅（离线单测）/ 未实机执行 | `tests/migration.test.mjs`（12 项）：分类、行移除、管理块幂等、裸 `[]` 处理、保留无关行、未确认拒绝、缺 config 且无 env 时拒绝、临时 profile 端到端写入、环境变量生成 `config.json`、扫描不泄露密钥；本机已是自愿版，没有在真实 profile 上执行破坏性迁移 |
| `/lf on --history` 历史补传 | ✅（离线集成 3/3）/ 真实会话“暂存”已验证，“发送”未实测 | `tests/uploader-history.test.mjs`：真实上传器模块 + 本地 OTLP sink，暂存 2 个历史轮次，下一条消息后产生 3 个 trace（turn 1/2/3）内容正确且只发一次；普通 `on` 不发历史；非法参数拒绝。真实 DSH 审计日志有 `history-staged turns:2` |

**测试会话与上传记录**：
- 早期验收会话 `Greeting` / `session-e924eddc-…`：上传 turn 2（我的 `ok`）与 turn 3（验证期间你输入的一句话），turn 1 未上传。
- 修复后复测会话 `New session upload baseline` / `session-9162c50e-…`：全新会话，上传 turn 2；其中“开启时正在进行的 turn 1”按设计不上传。
- 左右分离改版后复测会话 `回复收到` / `session-59f922d6-…`：只验证“左侧看详情 / 右侧切开关”，未发送新消息，日志无 `sent`、无上传（实拍：`v40/v42/v45/v46`）。
- 验证结束后所有会话均为「关闭」；**没有任何你已有的工作会话被开启**。

## 7. 已知限制（如实说明）

1. **空白「新会话」页没有页头操作区**：这是 DSH 本身的行为——空白会话隐藏标题、actions、utilities 和视图标签。开关在发出**第一条消息**、进入正常会话页头后出现，并且默认显示「关」（已用首轮消息验证：关闭状态下全程无上传）。DSH 没有在不改宿主代码的前提下把控件放进空白英雄页的正式扩展位。
2. **切换工作区**未单独做界面实测；但每个会话页头都以自己的 `sessionId` 查询后台，与已实测的「跨会话切换」是同一条代码路径。切换工作区若重新挂载会话视图，也会重新查询。
3. **真实网络中断**未专门制造；用「停用上传器插件」模拟了查询失败/恢复（显示「状态未知」→ 恢复后自动查询）。Connection 断线重连会触发页头主动刷新（已订阅 generation 变化）。
4. **后端拒绝操作**的界面路径没有在真实环境触发（正常活动会话很难让上传器拒绝）；由离线单测覆盖：拒绝/未确认都会变成「状态未知」，绝不显示成功。
5. **整机重启 DSH** 未实测（避免打断你的工作进程）；上传器重载已实测会恢复全部关闭，而授权只存在进程内存，机制上等价。
6. **下游度量页面（`<内部度量页面>`）**是否已刷新属异步同步，未直接验证；已分别确认「HTTP 200 接收」和「读接口可查到入库 trace」两个层级，不把二者混为一谈。
7. 视觉/文案按当前浅色主题与中文界面验证；深色主题使用同一套 `--dsw-alias-*` token，未见硬编码配色。开/未知状态文字使用 `color-mix` 与宿主主文字色混合以保持可读对比度，加载态不再叠透明度；无法使用 `color-mix` 时回退到状态 token 原色。
8. 已在交付前做一次独立 UX 评审并修复主要问题（对比度、`aria-checked` 语义、busy 时键盘焦点、错误文案、认证错误区分、tooltip 目的地与发送统计、“开≠发送成功”说明、reduced-motion）；修复记录只保留在本地。
9. 键盘 Tab 聚焦未在真实窗口中逐步录屏；无障碍属性与 busy 行为由代码和离线结构测试保证。
10. **原版自动采集的实机扫描未验证**：本机只装了自愿版，面板里「自动采集」分类与实际迁移按钮的实机呈现没有触发过；分类、计划与守卫由 `tests/migration.test.mjs` 覆盖。
11. **迁移「应用」没有在真实 profile 上执行**（本机已是自愿版）：写入前备份、幂等管理块、缺配置拒绝、残留行拒绝、8 秒加载检测、重启提示都已实现并单测，但破坏性实操建议先在测试机/测试 profile 上演练。
12. 扫描只覆盖 **DSH Loader 行**；Codex 等 DSH 之外的上报 hook（如原版包里的 Python hook）不会被发现或处理，面板结论仅针对 DSH。

13. **`/lf on --history` 的真实会话补传发送未完成实测**：离线集成测试已验证「暂存 → 下一条消息 → 3 个 trace」；真实 DSH 里只观察到 `history-staged turns:2` 的审计记录，下一条消息触发补传的完整链路尚未在真实会话中跑完（测试被模型报错打断）。建议先按 2.2 手动验证一次。

## 8. 停用与回滚

### 临时关闭（推荐日常使用）
- 在对应会话点开关变「关」，或在该会话输入 `/lf off`；
- 全部关闭：在任意会话输入 `/lf off-all`。

### 停用插件（保留文件，随时再开）
```
plugin_manager action=set_bundle target=@local/dsh-langfuse-header-toggle enabled=false
```
界面等价操作：**插件** 页里关闭该 Bundle。页头控件与网络监听会立即移除（已实测），上传器本身不受影响。

### 完全移除（可重装）
```
plugin_manager action=remove_bundle target=@local/dsh-langfuse-header-toggle
```
已实测「移除 → 开关消失 → 重新安装 → 开关恢复」。移除不会删除本目录源码。

### 回滚到安装前（只撤销本次变更）
安装只改了 desktop profile 的 `package.json`（`dsh.profile.bundles` + `dependencies`）和 `pnpm-lock.yaml`，浏览器/Worker 侧无落盘文件。
- 自动：执行上面的 `remove_bundle`，等价于撤销这两处变更；
- 手动（仅在上一步不可用时）：从 `package.json` 删除 `@local/dsh-langfuse-header-toggle` 对应的 bundles 行与 dependency 行，然后在该 profile 目录执行 `pnpm install`（或恢复备份中的 `pnpm-lock.yaml`）。
- **不要用整份旧 `cordis.patch.yml` 或旧 `package.json` 覆盖当前文件**——那会丢掉你之后新增的模型/插件设置。本次安装已把 `cordis.patch.yml` 恢复到与安装前**逐字节一致**（sha256 `036ba70b…`）。
- 上传器已从 1.0.1 升级为 **1.0.2**（新增 `/lf on --history`，采集/上传逻辑未变）：`%USERPROFILE%\.dsh\langfuse-voluntary\dsh-langfuse-voluntary-1.0.2.mjs`，sha256 `01c9b906…`；旧 1.0.1 文件保留未加载，需要回退时把 profile patch 中该行的 name 改回 1.0.1 并重载；`config.json` 未被修改。

### 撤销一次「迁移为自愿上传」
若在面板里点过「应用」：
- 每次迁移都会先备份被改文件到 `%USERPROFILE%\.dsh\langfuse-voluntary\backups\`（文件名含原文件名与时间戳）；
- 把对应 `.bak` 复制回原路径（profile 的 `cordis.patch.yml`，以及存在过的 `~/.dsh/cordis.patch.yml`），然后刷新/重启 DSH 让 Loader 重载即可；
- 迁移只改这两个配置文件，并可能把内置副本复制到 `~/.dsh/langfuse-voluntary/`（仅当该目录没有上传器模块时）；不改 `package.json`，不改你已有的 `config.json` 和上传器文件。

### 撤销 1.2.0 的「保存配置 / 安装上传器」
- 「保存配置」只写 `<DSH home>/langfuse-voluntary/config.json`；如需撤销，删除该文件或把备份的旧配置复制回来（该文件不在 profile 里，卸载插件不会自动删除）。
- 「安装上传器」只复制内置上传器模块并改 profile 的 `cordis.patch.yml`（写前已备份）；卸载插件不会删除 `~/.dsh/langfuse-voluntary/` 下的模块和 `config.json`，需要时按 `backups/` 里的 `.bak` 还原 patch，或手动删除该目录中的上传器文件。
- 这两个操作都不会开启任何会话；撤销后所有会话仍是关闭状态。

### 安装前备份
`backups/<时间戳>/`：安装前 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml` 及 `backup.json`（含 sha256）。

## 9. 文件说明

| 文件 | 作用 |
| --- | --- |
| `package.json` | Bundle 清单：`dsh.bundle.patch` + `dsh.client`（web 平台、立即加载、依赖顺序） |
| `cordis.patch.yml` | Host 行插入：`id: dsh-langfuse-header-toggle` |
| `index.js` | Host：五条认证 `/api` 路由（state/set/scan/migrate/config）+ 扫描、迁移、配置校验/原子写、上传器安装、卸载清理；无采集/上传逻辑 |
| `client.js` | 浏览器端：开关组件 + 上传钩子扫描面板（每次打开重新扫描）+ Langfuse 连接配置表单与上传器安装入口、竞态门、tooltip、无障碍、窄宽简写 |
| `vendor/dsh-langfuse-voluntary-1.0.2.mjs` | 迁移与「安装上传器」使用的自愿上传器副本（与已安装 1.0.2 一致；仅在目标目录缺失或内容不同时复制） |
| `vendor/config.example.json` | 配置模板（占位符，无真实密钥），说明字段与放置位置 |
| `locale/en.json`, `locale/zh.json` | 插件管理器里显示的标题/描述 |
| `icon.svg` | 插件图标 |
| `tests/bridge.test.mjs` | 桥接契约 + 真实上传器类集成测试（8 项，含五条路由注册契约） |
| `tests/client.test.mjs` | 客户端注册、竞态门、结果归一、请求形态、配置表单辅助函数测试（10 项） |
| `tests/client-structure.test.mjs` | 左右分离结构/行为测试 + 配置表单默认不展开（5 项） |
| `tests/migration.test.mjs` | 上传钩子分类、patch 行移除/管理块、迁移守卫、环境变量生成配置与临时 profile 端到端测试（12 项） |
| `tests/config.test.mjs` | 连接配置校验/脱敏/原子写、运行中上传器的 ready/pending 判定、安装幂等与备份、拒绝自动采集行、不调用 command()（15 项） |
| `tests/uploader-history.test.mjs` | 上传器 `/lf on --history` 历史补传集成测试（3 项，使用真实上传器模块与本地 OTLP sink） |
| `verification/` | 本地验证记录（截图/日志/查询结果，含会话内容，**不随仓库发布**） |
| `backups/` | 本地安装前 profile 备份（**不随仓库发布**） |

## 10. 开发与测试

无需 npm 依赖、无需构建（`client.js` 直接是浏览器模块加载器格式）。

```powershell
# 语法检查
node --check index.js
node --check client.js

# 离线测试（53 项：桥接 8 + 客户端 10 + 控件结构 5 + 迁移 12 + 配置 15 + 上传器历史 3）
node tests/bridge.test.mjs
node tests/client.test.mjs
node tests/client-structure.test.mjs
node tests/migration.test.mjs
node tests/config.test.mjs
node tests/uploader-history.test.mjs

# 可选：真实上传器集成测试会读取已安装的 1.0.2 上传器（只读导入）
$env:DSH_LANGFUSE_UPLOADER = '%USERPROFILE%\.dsh\langfuse-voluntary\dsh-langfuse-voluntary-1.0.2.mjs'
node tests/bridge.test.mjs
$env:LANGFUSE_UPLOADER_PATH = '%USERPROFILE%\.dsh\langfuse-voluntary\dsh-langfuse-voluntary-1.0.2.mjs'
node tests/uploader-history.test.mjs
```

Host 接口（安装后）：
- `POST /api/dsh-langfuse-toggle/state`，body `{ "sessionId": "…" }` → `{ ok: true, value: {...} }`
- `POST /api/dsh-langfuse-toggle/set`，body `{ "sessionId": "…", "enabled": true|false }` → `{ ok: true, value: {...} }`
- `POST /api/dsh-langfuse-toggle/scan`，body `{}` → 上传钩子清单/运行时/配置/迁移可用性（只读）
- `POST /api/dsh-langfuse-toggle/migrate`，body `{ "confirm": true }` → 备份并迁移；未带 `confirm` 一律拒绝
- `POST /api/dsh-langfuse-toggle/config`，body `{ "action": "get" }` → `{ ok: true, value: <status> }`（脱敏状态：`path/exists/valid/ready/baseUrl/userId/maxChars/publicKeySet/secretKeySet/publicKeyHint/defaultOff/uploader`）
- `POST /api/dsh-langfuse-toggle/config`，body `{ "action": "save", "baseUrl", "publicKey", "secretKey", "userId", "maxChars"? }` → 校验后原子写 `config.json`，返回 `{ ok: true, value: <status>, saved: true, defaultOff: true }`；校验失败返回 `{ ok: false, error: { code: "invalid_config", message, details: { field, reason } } }`
- `POST /api/dsh-langfuse-toggle/config`，body `{ "action": "install" }` → 复制内置上传器 + 写受管 Loader 行（写前备份），返回 `{ ok, status: <status>, restartRequired, copied, changed, backups, alreadyInstalled, defaultOff: true }`；存在原版自动采集行时拒绝为 `auto_collector_present`
- 未认证请求由 DSH `/api` 通道直接 401/403；非 owner Peer 不可达；错误一律 `{ ok: false, error: { code, message, details } }`。

## 11. 故障排查

| 现象 | 检查 |
| --- | --- |
| 页头没有开关 | 插件页确认 `@local/dsh-langfuse-header-toggle` 已启用；刷新页面一次；确认当前会话不是空白「新会话」页 |
| 一直「状态未知」 | 插件页确认 `dsh-langfuse-voluntary` 行（`include:dsh-langfuse-voluntary-1-0-1`）active；打开面板看「Langfuse 连接配置」是否 `配置有效`；查看 `%USERPROFILE%\.dsh\langfuse-voluntary\control-events.jsonl` 最后一条 `loaded` |
| 面板里没有「Langfuse 连接配置」 | 该区域只在点开左侧「本会话上传」后出现；页面加载时不会展开。若打开后一直「正在读取配置…」，看浏览器控制台/刷新页面 |
| 保存配置成功但仍「状态未知」 | 上传器只在加载时读取一次 `config.json`；状态里若有「上传器尚未读取该配置」，重启 DSH 或重新加载上传器行后再点开关 |
| 点「安装上传器」被拒绝 | 面板提示「检测到原版自动采集行」时，先按 1.1 节执行「迁移为自愿上传」；安装接口不会重复实现迁移 |
| 点击后没变化 | 若仍「状态未知」，说明查询未成功，需先恢复后台；恢复后会自动刷新 |
| 开关显示「开」但平台没数据 | 只上传**开启后新开始**的轮次；先在页头确认「开」，再发送新消息；发送结果看 `control-events.jsonl` 的 `sent/failed` |
| 需要看最近发送结果 | 在该会话输入 `/lf status` |
| `/lf on --history` 没有补传 | 补传在**下一条消息开始**时触发；确认已经发出新消息；`/lf status` 看「待补传 N 轮」；`/lf off` 会清空待补传 |
| 历史补传数量不对 | 只包含开启前**已完成**的轮次；进行中/失败轮次不计；每个历史轮次单独一个 trace |
