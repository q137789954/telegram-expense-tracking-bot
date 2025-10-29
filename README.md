# Telegram Billing Bot (TypeScript + Drizzle + PostgreSQL)

使用 TypeScript、Telegraf、Drizzle ORM 和 PostgreSQL 构建的群账单机器人。机器人支持为每个群维护备用金、待支付金额（本金与服务费）并记录操作历史，同时提供 HTTP 接口获取历史账单。

## 功能概览

- 支持 `~300` / `～300` 添加待充值金额，自动计算服务费与需支付金额。
- 支持 `-~200` / `-～200` 减少待支付金额，防止减至负数。
- 支持 `+200` 入账与 `-100` 出账，实时更新备用金。
- 对每次操作记录事务历史，可通过接口查询。
- 针对每个群首次使用时自动创建账单数据。

## 环境要求

- Node.js 18+
- PostgreSQL 13+
- npm / pnpm / yarn（任选其一）

## 快速开始

1. **安装依赖**

   ```bash
   npm install
   ```

2. **配置环境变量**

   复制 `.env.example` 为 `.env` 并填写实际值：

   ```
   BOT_TOKEN=your-telegram-bot-token
   DATABASE_URL=postgres://user:password@localhost:5432/telegram_bot
   SERVICE_RATE=0.03%
   PUBLIC_APP_URL=https://your-domain.com
   PORT=3000
   ```

   - `SERVICE_RATE` 支持写成百分比（如 `0.03%` 表示 0.03%）或直接小数（如 `0.0003`）。
   - `PUBLIC_APP_URL` 用于生成“查看历史账单”按钮链接，可留空（本地开发时不会附带按钮）。上线时必须配置为 Telegram 可访问的 HTTPS 地址，否则按钮无法生效。
   - 机器人会自动识别群管理员（管理员与群主）才能执行指令，无需额外配置。

3. **初始化数据库**

   运行 Drizzle SQL 脚本或使用你喜欢的迁移工具，执行 `drizzle/0000_initial.sql` 中的建表语句。

4. **启动机器人与 HTTP 服务**

   ```bash
   npm run dev
   ```

   或构建后运行：

   ```bash
   npm run build
   npm start
   ```

## Telegram 指令说明（群聊中）

- `~300` / `～300`：记录待充值 300 元，机器人会回复：
  - 充值金额
  - 服务费（按 `SERVICE_RATE` 计算）
  - 需支付金额（本金 + 服务费）
  - 充值后备用金（当前备用金 + 本金）
  - “查看历史账单”按钮，点击跳转至该群的账单页面
- `-~200` / `-～200`：减少待支付金额 200 元（含对应服务费），若减少后小于 0 会提示错误。
- `+200`：入账 200 元，备用金增加并回复最新余额。
- `-100`：出账 100 元，备用金减少并回复最新余额。

> 以上指令仅在群聊中生效，且会被记入数据库的历史记录。

## HTTP 接口

- `GET /health`：健康检查。
- `GET /history/:chatId?limit=50`：获取指定 `chatId` 的账单历史（JSON）。`limit` 可选，默认返回最近 50 条。
- `GET /history/:chatId/view?limit=50`：历史账单 HTML 页面，供机器人按钮访问。

响应示例：

```json
{
  "chatId": "-1001234567890",
  "chatTitle": "示例群组",
  "reserveBalance": "500.000000",
  "pendingAmount": "309.000000",
  "transactions": [
    {
      "id": 1,
      "groupId": 1,
      "type": "PENDING_ADD",
      "amount": "300.000000",
      "reserveAfter": "500.000000",
      "pendingAmountAfter": "309.000000",
      "note": "管理员 123456789 增加待充值金额（本金 300.000000，手续费 9.000000）",
      "createdAt": "2024-03-24T12:00:00.000Z"
    }
  ]
}
```

## 代码结构

- `src/index.ts`：入口文件，同时启动 Telegram Bot 与 HTTP Server。
- `src/telegram/bot.ts`：机器人命令解析与业务逻辑。
- `src/services/billingService.ts`：使用 Drizzle 操作 PostgreSQL 的业务层。
- `src/server/http.ts`：Express HTTP 接口。
- `src/db/schema.ts`：数据库 schema 定义。
- `drizzle/0000_initial.sql`：初始建库脚本。

## 常见问题

- 如出现 “无权限” 提示，确认消息发送者是否为群管理员或群主。
- 若服务费计算有差异，确认 `SERVICE_RATE` 是否按预期设置（百分比与小数写法不同）。
- 机器人需被添加为群管理员或至少拥有读取消息的权限，才能接收群内指令。

## 后续扩展建议

- 添加命令查询当前余额与待支付总额。
- 为 HTTP 接口增加鉴权。
- 使用 Drizzle Kit 自动生成迁移并集成 CI/CD。
