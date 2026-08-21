# Little Tool · 私人工作台

一组彼此独立、共用一个本地入口的私人 Web 空间：

- **职迹 `/career`**：求职进度、任务、联系人、面试与面经、材料及复盘。
- **拾词 `/vocab`**：在英文文章和播客语境中学习单词，英文解释优先，中文解释可选。
- **适练 `/fitness`**：先记录真实场地、器材、重量和身体边界，再生成可执行的训练计划与日历。

项目默认只监听 `http://localhost:3000`。结构化数据存放在浏览器 OPFS 中的 SQLite 数据库，文件也保存在 OPFS；服务器只负责按需抓取公开内容及转发明确触发的 AI 请求。

## 本地运行

要求 Node.js `>=22.13.0`，推荐使用 pnpm。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。请始终使用同一个主机名和端口；OPFS 按来源隔离，改用 `127.0.0.1` 或其他端口会看到另一份存储空间。

常用命令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## AI 配置

复制 `.env.example` 为 `.env.local`，填写服务端环境变量：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

密钥不会发送到浏览器，也不会进入 SQLite、备份或 Git。AI 功能只在用户主动触发时，把完成当前任务所需的文本上下文发送给配置的模型服务。

DeepSeek 的聊天接口不提供音频转录。拾词可以直接导入 SRT、VTT、LRC 和纯文本字幕；如需自动转录，可额外配置一个 OpenAI-compatible 转录端点：

```dotenv
TRANSCRIPTION_API_KEY=
TRANSCRIPTION_BASE_URL=
TRANSCRIPTION_MODEL=whisper-1
```

未配置转录服务不会影响文章学习、RSS 导入、字幕导入或其他 AI 功能。

## 数据与隐私

- 每个空间使用独立 SQLite 文件、产品身份、文件命名空间与完整备份，避免数据互相影响；当前分别为 `career`、`vocab` 与 `fitness`。
- SQLite 在专用 Web Worker 中运行，避免阻塞界面；数据库和附件默认保存在浏览器 OPFS。
- 清除浏览器站点数据、删除浏览器配置或更换来源会导致本地数据不可见，因此请定期从设置页导出备份。
- OPFS 是本地存储，不等同于加密保险箱；能访问当前系统用户或浏览器会话的软件仍可能读取数据。
- 除已配置的 AI/转录端点和用户主动导入的公开 URL 外，应用不加载第三方脚本。

## LinkedIn 与 BOSS 直聘

职迹保留原始职位链接，并支持粘贴职位链接、分享文本和 LinkedIn Saved Jobs CSV。公开页面受登录、地区和反自动化策略影响时，可粘贴职位描述作为可靠回退。项目不模拟登录、不抓取私人会话，也不声称使用受限的招聘合作伙伴 API。

## 仓库约定

- `.env.local` 和所有 `.env*` 默认忽略，只有空白模板 `.env.example` 可提交。
- 不把音频、简历或数据库文件放进仓库。
- 功能按基础设施、各个空间、验证与打磨拆分提交，便于回退和审阅；新增空间不需要改写现有空间的 UI 或数据层。
