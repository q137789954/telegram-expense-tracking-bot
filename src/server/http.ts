import express from 'express';
import { desc, eq } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { groupBalances, transactions } from '../db/schema.js';

// 将输出到 HTML 的内容进行转义，防止出现 XSS。
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 聚合查询，每次同时返回群组汇总与最近交易记录。
async function getHistory(chatId: string, limit: number) {
  const group = await db.query.groupBalances.findFirst({
    where: eq(groupBalances.chatId, chatId),
  });

  if (!group) {
    return null;
  }

  const history = await db
    .select()
    .from(transactions)
    .where(eq(transactions.groupId, group.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);

  return { group, history };
}

// ---- helpers shared across views ----
const toNum = (value: unknown) =>
  typeof value === 'number' ? value : Number((value as any)?.valueOf?.() ?? value);

const fmtNumber = (value: unknown, fractionDigits = 2) => {
  const n = toNum(value);
  return Number.isFinite(n) ? n.toFixed(fractionDigits) : String(value ?? '');
};

const fmt2 = (value: unknown) => fmtNumber(value, 2);

const mapTransactionType = (tx: any) => {
  switch (tx.type) {
    case 'PENDING_REDUCE':
      return '出账';
    case 'DEPOSIT':
      return '入账';
    case 'SERVICE_RATE_UPDATE':
      return '服务费率调整';
    case 'PENDING_ADD': {
      const n = toNum(tx.amount);
      if (!Number.isFinite(n)) return 'PENDING_ADD';
      return n >= 0 ? '+' : '-';
    }
    default:
      return String(tx.type ?? '');
  }
};

const xmlEscape = (value: unknown) => escapeHtml(String(value ?? ''));

const buildHistoryExcelXml = (group: any, history: any[]) => {
  const headerRow = `
        <Row>
          <Cell><Data ss:Type="String">ID</Data></Cell>
          <Cell><Data ss:Type="String">类型</Data></Cell>
          <Cell><Data ss:Type="String">金额</Data></Cell>
          <Cell><Data ss:Type="String">操作后备用金</Data></Cell>
          <Cell><Data ss:Type="String">操作后待支付</Data></Cell>
          <Cell><Data ss:Type="String">创建时间</Data></Cell>
          <Cell><Data ss:Type="String">备注</Data></Cell>
        </Row>`;

  const rows =
    history.length === 0
      ? `<Row><Cell ss:MergeAcross="6"><Data ss:Type="String">暂无记录</Data></Cell></Row>`
      : history
          .map(
            (tx: any) => `
        <Row>
          <Cell><Data ss:Type="String">${xmlEscape(tx.id)}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(mapTransactionType(tx))}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(fmtNumber(tx.amount))}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(fmtNumber(tx.reserveAfter))}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(fmtNumber(tx.pendingAmountAfter))}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(tx.createdAt?.toISOString?.() ?? '')}</Data></Cell>
          <Cell><Data ss:Type="String">${xmlEscape(tx.note ?? '—')}</Data></Cell>
        </Row>`,
          )
          .join('');

  const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Author>Telegram Billing Bot</Author>
    <Created>${new Date().toISOString()}</Created>
  </DocumentProperties>
  <Worksheet ss:Name="历史账单">
    <Table>
      ${headerRow}
      ${rows}
    </Table>
  </Worksheet>
</Workbook>`;

  return workbook;
};
// -------------------------------------

export async function startServer() {
  // 创建 Express 实例并挂载接口。
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // JSON 接口：提供给外部系统读取账单历史。
  app.get('/history/:chatId', async (req, res) => {
    const { chatId } = req.params;
    const limitParam = req.query.limit;
    const limit =
      typeof limitParam === 'string' && Number.parseInt(limitParam, 10) > 0
        ? Number.parseInt(limitParam, 10)
        : 50;

    // 对 limit 做上限限制，避免一次性查询过多数据。
    const safeLimit = Math.min(limit, 500);

    const data = await getHistory(chatId, safeLimit);

    if (!data) {
      res.status(404).json({ error: '未找到对应群组数据' });
      return;
    }

    const { group, history } = data;

    res.json({
      chatId: group.chatId,
      chatTitle: group.chatTitle,
      reserveBalance: group.reserveBalance,
      pendingAmount: group.pendingAmount,
      transactions: history,
    });
  });

  // Excel 下载：提供历史记录的 Excel 文件。
  app.get('/history/:chatId/export', async (req, res) => {
    const { chatId } = req.params;
    const limitParam = req.query.limit;
    const limit =
      typeof limitParam === 'string' && Number.parseInt(limitParam, 10) > 0
        ? Number.parseInt(limitParam, 10)
        : 50;

    const safeLimit = Math.min(limit, 500);

    const data = await getHistory(chatId, safeLimit);

    if (!data) {
      res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('未找到对应群组数据');
      return;
    }

    const { group, history } = data;

    const xml = buildHistoryExcelXml(group, history);

    const rawFileName = `${group.chatTitle ?? group.chatId ?? 'history'}-历史账单.xls`;
    const asciiFallback = rawFileName.replace(/[^\x20-\x7E]/g, '_');
    const encodedFileName = encodeURIComponent(rawFileName);

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFileName}`,
    );
    res.send(xml);
  });

  // HTML 页面：供机器人内联按钮快速打开查看。
  app.get('/history/:chatId/view', async (req, res) => {
    const { chatId } = req.params;
    const limitParam = req.query.limit;
    const limit =
      typeof limitParam === 'string' && Number.parseInt(limitParam, 10) > 0
        ? Number.parseInt(limitParam, 10)
        : 50;

    const safeLimit = Math.min(limit, 500);

    const data = await getHistory(chatId, safeLimit);

    if (!data) {
      res
        .status(404)
        .type('text/html')
        .send('<h1>未找到对应群组数据</h1>');
      return;
    }

    const { group, history } = data;

    const encodedChatId = encodeURIComponent(chatId);
    const exportUrl = `/history/${encodedChatId}/export?limit=${safeLimit}`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>历史账单 - ${escapeHtml(group.chatTitle ?? group.chatId)}</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin: 0; padding: 24px; background: #f7f7f7; color: #222; }
      h1 { margin-bottom: 8px; }
      p.meta { margin-top: 0; color: #555; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; background: #fff; }
      th, td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; }
      th { background: #fafafa; font-weight: 600; }
      tr:hover { background: #f0f8ff; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; background: #eef; color: #225; font-size: 12px; }
      .num { font-variant-numeric: tabular-nums; }
      .actions { margin-top: 16px; }
      .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; background: #1f7ae0; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; transition: background 0.2s ease; }
      .btn:hover { background: #1660b8; }
      .btn:active { background: #0f4f88; }
      .btn svg { width: 16px; height: 16px; fill: currentColor; }
    </style>
  </head>
  <body>
    <h1>历史账单</h1>
    <p class="meta">
      群组：${escapeHtml(group.chatTitle ?? '未命名群组')}（${escapeHtml(group.chatId)}）<br />
      当前备用金：<span class="num">${fmt2(group.reserveBalance)}</span>
      &nbsp;&nbsp;当前待支付总额（含手续费）：<span class="num">${fmt2(group.pendingAmount)}</span>
    </p>
    <div class="actions">
      <a class="btn" href="${exportUrl}" download>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 20h14a1 1 0 0 0 0-2H5a1 1 0 0 0 0 2Zm7-3 5-5h-3V4h-4v8H7l5 5Z"/>
        </svg>
        导出 Excel
      </a>
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>类型</th>
          <th>金额</th>
          <th>操作后备用金</th>
          <th>操作后待支付</th>
          <th>创建时间</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        ${
          history.length === 0
            ? '<tr><td colspan="7">暂无记录</td></tr>'
            : history
                .map((tx: any) => {
                  const note = tx.note ? escapeHtml(tx.note) : '—';
                  const typeLabel = escapeHtml(mapTransactionType(tx));
                  return `<tr>
            <td>${tx.id}</td>
            <td><span class="badge">${typeLabel}</span></td>
            <td class="num">${fmt2(tx.amount)}</td>
            <td class="num">${fmt2(tx.reserveAfter)}</td>
            <td class="num">${fmt2(tx.pendingAmountAfter)}</td>
            <td>${tx.createdAt?.toISOString?.() ?? ''}</td>
            <td>${note}</td>
          </tr>`;
                })
                .join('')
        }
      </tbody>
    </table>
  </body>
</html>`;

    res.type('text/html; charset=utf-8').send(html);
  });

  return new Promise<void>((resolve) => {
    app.listen(env.port,'0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`HTTP server listening on port ${env.port}`);
      resolve();
    });
  });
}
