# Hearthkeeper 团队功能说明书（中文版）

> 给负责拍视频/演示的组员看。一句话：**Hearthkeeper = 一个由 Minds AI Agent 驱动的社区自动版主**。Mind 是大脑（理解社区规范、记住成员、自己跟进），应用是外壳（队列、词库、Discord bot、审计记录）。

---

## 一、核心概念（30 秒讲清楚）

- **Mind（jackjoyool）**：部署在 Minds 平台的 AI Agent，是这个产品的"版主大脑"。它被"教"了社区的规范（`norms/community.md`），并且**记得住**——跨会话、跨重启。
- **引擎（server）**：本地跑的服务（`npm start`），管队列、数据库、调度。
- **Discord bot**（`npm run discord`）：把 Discord 频道和引擎接起来，判决直接回贴在频道里。

## 二、功能清单（拍视频时逐个展示）

### 1. 智能审核（核心）—— Mind 判决每一帖
- **是什么**：每一条消息入队后，Mind 按社区规范给出判决：`allow`（放行）/ `flag`（可疑，转人工）/ `remove`（违规删除），带严重度、类别、理由。
- **为什么强**：判决**引用社区规则和先例**，比如 *"violates Rule 2 (no crypto giveaways); matches the precedent 'check out my new NFT collection' → remove"*。
- **怎么演示**：Discord 里发一条广告帖（如 "check out my new NFT, dm me"）→ 等 30–90 秒 → bot 回贴判决。或者网页仪表盘点 **Review queue →**。
- ⚠️ 注意：Mind 推理需要 **30–90 秒**，不是卡了，是正常的。

### 2. 持久记忆（评审关键点！）
- **是什么**：Mind 记住所有审核记录、成员违规史。**重启服务、隔天再来，它都记得**。
- **怎么演示（必拍镜头）**：
  1. 审核几条消息
  2. `Ctrl+C` 关掉引擎，重新 `npm start`
  3. 在 Discord 或网页 Mind chat 里问：*"Who did we remove yesterday and why?"*
  4. Mind 从记忆里回答（还知道哪个用户是惯犯、被升级了什么处罚）

### 3. 升级审查（escalation）—— 惯犯自动升级
- **是什么**：违规 ≥1 次的成员会被 Mind 审查，按阶梯处罚：`warn`（警告）→ `restrict`（禁言）→ `ban`（封禁）。
- **怎么演示**：Discord 里输入 `!audit`（会连日报一起跑），或 `!escalate`。同一个用户骂两次，第二次判决明显更重。

### 4. 黑名单秒删（instant blacklist）
- **是什么**：`blacklist.txt` 里的词（如 `sb`、`fuck you`、`傻逼`），**命中瞬间删除**，不用等 Mind、不花 AI 额度。
- **英文词是整词匹配**：`sb` 只删独立的 "sb"，不会误删 `alsbachite`、`absorb`。
- **怎么演示**：Discord 里发一句 "you are sb" → **立即被删** + bot 提示 `Blacklisted term: "sb"`。发 "alsbachite is a mineral" → 不误删。
- **管理**：`!blacklist add 新词` / `!blacklist remove 词` / `!blacklist list`（即时生效，不用重启）。

### 5. 白名单秒放行（whitelist）
- **是什么**：`whitelist.txt` 里的安全词（如 `wip`、`critique welcome`），命中**直接放行**，不经过 Mind。
- **怎么演示**：发 "wip! trying painterly lighting" → 立即放行，零等待。
- **管理**：`!whitelist add|remove|list`。

### 6. AI 自动学习词库（亮点）
- **是什么**：Mind 判决时会指出"导致判决的关键词"（`keywords`），应用自动把它们**写进黑名单（判删）或白名单（判放）**——越用越准、越用越省。
- **怎么演示**：观察终端日志里的 `[learn] blacklist += "..."`，或者 `!blacklist list` 看词库在自动增长。

### 7. 人工复核（human-in-the-loop）
- **是什么**：`flag` 判决的帖子转人工。版主在 Discord 里直接裁决。
- **怎么演示**：`!flagged` 列出待复核帖 → `!decide <postId> allow|remove 备注` 裁决 → Mind 会**学习这次纠正**（下次判对）。

### 8. 自主日报（digest）
- **是什么**：每天早上 Mind 自动写社区健康报告（评分/100、关注点、改进建议）。调度器（cron）自动跑，不用人管。
- **怎么演示**：`!digest`，或网页 Reports 标签看卡片。

### 9. 网页仪表盘（dashboard）
- **是什么**：http://localhost:4173 的管理界面：队列、判决记录、成员状态、报告、Mind 聊天。每条判决可点 **Override** 人工改判。
- **怎么演示**：浏览器打开，逐个标签过一遍；改一条判决给 Mind 看纠正效果。

### 10. 全量命令 `!audit`
- **是什么**：一条命令跑完整个流程：审完队列 → 升级审查 → 健康日报。
- **怎么演示**：Discord 输入 `!audit`，bot 依次回贴三部分结果。**这是视频里最省事的"一条龙"镜头**。

### 11. 真实处罚执行 `!enforce`
- **是什么**：升级裁决（restrict/ban）默认只记录状态；`!enforce` 让版主确认后**真正执行到 Discord**：`restrict` → 禁言 10 分钟，`ban` → 封禁。
- **为什么手动**：封禁是破坏性操作，AI 裁决 + 人工确认是正确姿势。
- **怎么演示**：`!audit` 出裁决 → `!enforce` → bot 真的禁言/封禁违规小号（需要 bot 有 Timeout Members / Ban Members 权限）。
- 用法：`!enforce`（全部）/ `!enforce restrict` / `!enforce ban`。

### 12. 私信警告阶梯（只有违规者能看到）
- **是什么**：每次违规（黑名单秒删或 Mind 判删），bot 自动给**违规者本人**发私信，按累计违规数分三档：
  - 第 1 次 → 温和提醒（说明再犯的后果）
  - 第 2 次 → "你已被禁言 10 分钟" + **真的禁言 10 分钟**
  - 第 3 次+ → 最终封禁警告（再犯就封）
- **怎么演示（效果最好的一段）**：小号连发 3 条违规消息 → 小号收到 3 封不同等级的私信，第 2 次真的说不出话 10 分钟。
- ⚠️ 用户关闭私信时发送失败，只记日志不影响审核。

### 13. 输出集中频道（可选）
- `DISCORD_OUTPUT_CHANNEL_ID` 配置后，所有 bot 判决/命令回复集中到一个频道（如 `#bot-output`），成员频道保持干净。

### 14. 刷屏防护（flood guard）
- **是什么**：同一成员在 10 秒内发超过 5 条消息 → 第 6 条起**自动删除**（reason: message flood），不需要 Mind 判断。
- **为什么需要**：以前刷屏时消息只是排队，用户没感知；现在刷屏本身就被处罚，正常消息一条不漏地必审。
- **怎么演示**：小号连发 6 条 "hi" → 前 5 条入队（稍后 bot 回贴判决），第 6 条当场被删 + bot 提示 flood。
- 阈值可调：`.env` 里 `FLOOD_WINDOW_MS`（窗口毫秒）/ `FLOOD_MAX`（条数）。

### 15. 拉黑用户（user blacklist）
- **是什么**：把某个成员拉黑后，他发的**所有消息**（不管内容）在 ingest 阶段**即时秒删**，不走 Mind、零成本。拉黑记录在 `banned_users.txt`。
- **怎么演示**：`!banuser @小号` → 小号发任何消息都被秒删 +（有权限时）尝试封禁该成员；`!bannedlist` 查看；`!unbanuser @小号` 解除。
- ⚠️ 与 `!enforce` 的区别：`!banuser` 是**消息级拦截**（他发什么都被删但还在服务器），`!enforce ban` 是**真封禁**（踢出服务器）。两套独立。

### 16. 廣告/邀請連結攔截（link guard）
- **是什么**：Discord 邀请链接（`discord.gg/xxx` 等）和**非白名单的外部链接**在 ingest 阶段被拦截，不走 Mind。
  - Discord 邀请 → **秒删**（reason: Discord invite link）
  - 非白名单外部链接（老号）→ **秒删**（reason: External promotional link blocked）
  - 白名单域名（`allowed_domains.txt`）→ **放行**（支持子域名）
- **怎么演示**：发 `discord.gg/abc` → 秒删；发 `https://某外网.com` → 老号秒删；`!allowdomain add 你的域名` → 该域名放行。
- 白名单为空时 = 所有外部链接都拦（推荐，默认全拦再逐步放开）。

### 17. 新号冷卻（newbie cooldown）
- **是什么**：进群 < 24 小时（可调）的新号，发外部链接 → **不秒删**，而是**持有转人工复核**（flag）——避免误伤刚来的正常用户，同时挡住机器人轰炸/广告小号。
- **怎么演示**：新号发外链 → bot 提示"new member... held for review"，`!flagged` 能查到待人工复核。
- 命令：`!onboard cooldown set <小时>` / `!onboard cooldown show`。

### 18. 新成员欢迎（Mind says hello）
- **是什么**：新成员加入服务器时，**Mind 写个性化欢迎语**（含用户名）发到欢迎频道（30–90 秒生成）。Mind 挂了自动用模板兜底。
- **怎么演示**：邀请一个小号进服务器 → 欢迎频道出现带名字的欢迎语。
- ⚠️ 需先在 Discord Developer Portal 开启 **SERVER MEMBERS INTENT** 并重新邀请 bot；配置 `DISCORD_WELCOME_CHANNEL_ID`（不填用系统频道）。每条欢迎耗 1 次 cognition。

## 三、Discord 命令速查

| 命令 | 作用 |
|---|---|
| `!review` | 审核整个队列 |
| `!audit` | 队列 + 升级 + 日报 一条龙 |
| `!flagged` | 列出待人工复核 |
| `!decide <postId> <allow\|flag\|remove> [备注]` | 人工裁决 |
| `!blacklist add\|remove\|list <词>` | 管理黑名单 |
| `!whitelist add\|remove\|list <词>` | 管理白名单 |
| `!stats` | 成员违规统计 |
| `!digest` | 今日健康日报 |
| `!enforce [restrict\|ban]` | 把升级裁决真正执行到 Discord（禁言/封禁） |
| `!banuser @成员` | 拉黑用户（消息全部秒删，可尝试封禁） |
| `!unbanuser @成员` | 解除拉黑 |
| `!bannedlist` | 列出已拉黑用户 |
| `!onboard cooldown set\|show <小时>` | 新号冷却时长设置/查看 |
| `!allowdomain add\|remove\|list <域名>` | 管理链接白名单域名 |
| `!help` | 命令列表 |

**自动行为（无需命令）**：黑名单秒删、白名单秒放行、私信警告阶梯、刷屏防护、Discord邀请拦截、外部链接拦截、新号冷却持有转人工、新成员欢迎、每日自动日报。

## 四、给拍摄者的提示

- **数据重置**：测试/演示前跑 `npm run reset`（清空全部记录，从零开始——之后 digest/stats 只反映真实活动）。黑/白名单词库不受影响。
- **启动**：`npm start`（引擎）+ `npm run discord`（bot），两个终端。
- **常见"看似故障"**：
  - 判决 30–90 秒 → 正常，Mind 在思考
  - 词库命中秒删 → 正常，不是 bug
  - `!review` 提示"审核进行中" → 上一轮还没完，等一会
- **演讲要点（30 秒版）**：创作者付不起 24/7 人工版主 → 关键词过滤太蠢 → Hearthkeeper 用 AI Agent 学会你的规范、记住每个成员、自己跟进，黑名单兜底零成本。
