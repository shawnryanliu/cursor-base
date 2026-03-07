# cursor-base 项目文档

## 项目简介

一个 ChatGPT 风格的 AI 聊天应用，前后端分离，后端调用 MiniMax API，对话历史存储在 MySQL。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 纯 HTML + CSS + JS（无框架） |
| 后端 | Node.js + Express |
| AI 模型 | MiniMax-M2.5（通过 Anthropic SDK 兼容接口调用） |
| 数据库 | MySQL 5.7 |
| 进程管理 | PM2 |
| Web 服务器 | Nginx（宝塔面板安装） |
| 版本控制 | Git + GitHub |

---

## 服务器信息

| 项目 | 值 |
|---|---|
| 云服务商 | 腾讯云 |
| IP | 43.160.235.189 |
| SSH 端口 | 54321（已从默认 22 修改，防止暴力破解） |
| SSH 用户 | root |
| SSH 密钥 | `~/.ssh/id_ed25519`（本地已配置免密登录） |
| 前端访问端口 | 8081 |
| 后端端口 | 4000 |
| 项目目录 | `/www/wwwroot/claude-chat/` |

---

## 项目结构

```
cursor-base/
├── frontend/
│   └── index.html          # 前端页面（ChatGPT 风格深色主题）
├── backend/
│   ├── server.js           # Express 后端
│   └── package.json
├── docs/
│   └── project-overview.md # 本文件
├── deploy.sh               # 一键部署脚本
├── .env.example            # 环境变量模板
└── .gitignore              # 排除 .env 和 node_modules
```

---

## 环境变量（服务器 `.env`，不提交 git）

文件位置：`/www/wwwroot/claude-chat/backend/.env`

```
MINIMAX_API_KEY=...       # MiniMax API Key
PORT=4000                 # 后端端口
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=...        # MySQL 密码，在宝塔面板可查
MYSQL_DB=claude_chat
```

---

## 数据库结构

数据库名：`claude_chat`

```sql
-- 对话表
CREATE TABLE conversations (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) DEFAULT '新对话',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 消息表
CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  role ENUM('user', 'ai') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
```

---

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/conversations` | 获取所有对话列表 |
| POST | `/api/conversations` | 创建新对话 |
| GET | `/api/conversations/:id/messages` | 获取指定对话的消息历史 |
| DELETE | `/api/conversations/:id` | 删除对话 |
| POST | `/api/chat` | 发送消息（SSE 流式返回） |

`/api/chat` 请求体：
```json
{ "prompt": "用户消息", "conversationId": "uuid" }
```

---

## MiniMax API 配置

MiniMax 兼容 Anthropic SDK，只需修改 `baseURL`：

```js
const client = new Anthropic({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: "https://api.minimax.io/anthropic",
});
```

模型名：`MiniMax-M2.5`（也支持 `MiniMax-M2.5-highspeed`、`MiniMax-M2.1` 等）

---

## 部署流程

### 日常更新（git 流）

```bash
# 本地开发完成后
git add .
git commit -m "feat: xxx"
git push

# 让 Claude 执行，或手动 SSH 执行
ssh -p 54321 root@43.160.235.189 "cd /www/wwwroot/claude-chat && bash deploy.sh"
```

`deploy.sh` 做的事：`git pull` → `npm install --production` → `pm2 restart claude-chat --update-env`

### 首次部署（新项目）

使用 `/deploy` skill，会引导完成 rsync 上传、Nginx 配置、PM2 启动全流程。

---

## Nginx 配置

前端静态文件配置：`/www/server/panel/vhost/nginx/claude-chat.conf`

```nginx
server {
    listen 8081;
    server_name _;
    root /www/wwwroot/claude-chat/frontend;
    index index.html;
}
```

重载 Nginx：`/www/server/nginx/sbin/nginx -s reload`

---

## GitHub 仓库

`https://github.com/shawnryanliu/cursor-base`（Public）

服务器已配置 git remote，直接 `git pull` 即可获取更新。

---

## 已知问题 / 注意事项

- 服务器上 3000、3001 端口已被其他进程占用，后端使用 4000
- `.env` 文件只存在于服务器，不在 git 中，手动维护
- MySQL root 密码在宝塔面板 → 数据库可查
- 腾讯云安全组需要和服务器防火墙同步开放端口
- SSH 端口改为 54321 后，暴力破解流量大幅减少

---

## 待开发功能（想法）

- [ ] 用户登录 / 多用户支持
- [ ] Markdown 渲染
- [ ] 代码高亮
- [ ] 导出对话
- [ ] 移动端适配
