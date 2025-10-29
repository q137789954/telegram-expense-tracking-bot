import Decimal from 'decimal.js';
import { Context, Markup, Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup, MessageEntity } from 'telegraf/types';

import { env } from '../config/env.js';
import {
  addPendingAmount,
  deductReserve,
  reducePendingAmount,
  updateGroupServiceRate,
} from '../services/billingService.js';
import {
  addGroupOperator,
  isGroupOperator,
  removeGroupOperator,
} from '../services/operatorService.js';
import { formatCurrency } from '../utils/format.js';

type BotContext = Context;
type TelegramUser = NonNullable<BotContext['from']>;

interface ParsedCommand {
  kind: 'PENDING_ADD'| 'REDUCE' | 'DEPOSIT';
  amount: Decimal;
}

const bot = new Telegraf<BotContext>(env.botToken);
const ZERO = new Decimal(0);
const chatUserCache = new Map<string, Map<string, TelegramUser>>();

function isGlobalAdmin(userId?: number): boolean {
  if (typeof userId !== 'number') {
    return false;
  }
  return env.botAdminIdSet.has(String(userId));
}

async function hasBotPermission(
  chatId: string,
  userId?: number,
): Promise<boolean> {
  if (typeof userId !== 'number') {
    return false;
  }
  if (isGlobalAdmin(userId)) {
    return true;
  }
  return isGroupOperator(chatId, String(userId));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getUserDisplayName(user: {
  first_name?: string;
  last_name?: string;
  username?: string;
  id: number;
}): string {
  const names = [user.first_name, user.last_name].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  if (names.length > 0) {
    return names.join(' ');
  }
  if (user.username) {
    return `@${user.username}`;
  }
  return String(user.id);
}

function isGroupChat(ctx: BotContext): boolean {
  const chatType = ctx.chat?.type;
  return chatType === 'group' || chatType === 'supergroup';
}

function rememberUser(chatId: string, user: TelegramUser): void {
  const username = user.username?.trim();
  if (!username) {
    return;
  }
  const normalized = username.toLowerCase();
  let userMap = chatUserCache.get(chatId);
  if (!userMap) {
    userMap = new Map();
    chatUserCache.set(chatId, userMap);
  }
  userMap.set(normalized, user);
}

function findCachedUser(chatId: string, username: string): TelegramUser | null {
  const userMap = chatUserCache.get(chatId);
  if (!userMap) {
    return null;
  }
  return userMap.get(username.toLowerCase()) ?? null;
}

async function resolveUserByUsername(
  ctx: BotContext,
  chatId: number,
  username: string,
): Promise<TelegramUser | null> {
  const cleaned = username.replace(/^@+/, '').trim();
  if (!cleaned) {
    return null;
  }
  const chatIdKey = String(chatId);

  const cached = findCachedUser(chatIdKey, cleaned);
  if (cached) {
    return cached;
  }

  try {
    const chat = await ctx.telegram.getChat(`@${cleaned}`);
    if (chat && 'type' in chat && chat.type === 'private') {
      const member = await ctx.telegram.getChatMember(chatId, chat.id);
      rememberUser(chatIdKey, member.user as TelegramUser);
      return member.user as TelegramUser;
    }
  } catch {
    // ignore final failure, handled by caller
  }

  try {
    const admins = await ctx.telegram.getChatAdministrators(chatId);
    const matched = admins.find(
      (admin) => admin.user.username?.toLowerCase() === cleaned.toLowerCase(),
    );
    if (matched) {
      rememberUser(chatIdKey, matched.user as TelegramUser);
      return matched.user as TelegramUser;
    }
  } catch {
    // ignore failure, handled below
  }

  return null;
}

const COMMAND_TARGET_HINT = '请在命令后加上目标用户的 @用户名 再执行此命令';

async function resolveCommandTarget(
  ctx: BotContext,
): Promise<{ ok: true; user: TelegramUser } | { ok: false; message: string }> {
  if (!isGroupChat(ctx) || !ctx.chat) {
    return { ok: false, message: '该命令仅能在群聊中使用' };
  }

  const message = ctx.message;
  if (!message) {
    return { ok: false, message: '未能读取消息内容，请稍后重试' };
  }
  if (!('text' in message)) {
    return { ok: false, message: '请以文本消息的形式执行该命令' };
  }

  const entities = (message.entities ?? []) as MessageEntity[];
  const mentionEntity = entities.find((entity) => entity.type === 'mention');
  const chatId = ctx.chat.id;

  if (mentionEntity) {
    const mention = message.text.slice(
      mentionEntity.offset,
      mentionEntity.offset + mentionEntity.length,
    );
    const user = await resolveUserByUsername(ctx, chatId, mention);
    if (user) {
      if (user.is_bot) {
        return { ok: false, message: '无法对机器人执行此命令' };
      }
      return { ok: true, user };
    }
  }

  const tokens = message.text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    if (!token.startsWith('@')) {
      continue;
    }
    const user = await resolveUserByUsername(ctx, chatId, token);
    if (user) {
      if (user.is_bot) {
        return { ok: false, message: '无法对机器人执行此命令' };
      }
      return { ok: true, user };
    }
  }

  return { ok: false, message: '未找到目标用户，请确认 @用户名 正确且用户在本群中' };
}

function buildHistoryMarkup(chatId: string): InlineKeyboardMarkup | undefined {
  if (!env.publicAppUrl) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(env.publicAppUrl)) {
    return undefined;
  }
  const url = `${env.publicAppUrl}/history/${encodeURIComponent(chatId)}/view`;
  return Markup.inlineKeyboard([[Markup.button.url('查看历史账单', url)]]).reply_markup;
}

function parseAmount(
  raw: string | undefined | null,
  options?: { allowNegative?: boolean },
): Decimal | null {
  if (!raw) {
    return null;
  }
  try {
    const amount = new Decimal(raw);
    if (amount.eq(0)) {
      return null;
    }
    if (!options?.allowNegative && amount.lt(0)) {
      return null;
    }
    return amount;
  } catch (error) {
    return null;
  }
}

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, '');

  if (normalized.startsWith('+')) {
    const amount = parseAmount(normalized.slice(1), { allowNegative: true });
    if (!amount) {
      return null;
    }
    return { kind: 'PENDING_ADD', amount };
  }

  if (normalized.startsWith('-')) {
    const amount = parseAmount(normalized, { allowNegative: true });
    if (!amount) {
      return null;
    }
    return { kind: 'PENDING_ADD', amount };
  }

  if (/^出[帐账]/.test(normalized)) {
    const amount = parseAmount(normalized.slice(2));
    if (!amount) {
      return null;
    }
    return { kind: 'REDUCE', amount };
  }

  if (normalized.startsWith('入账')) {
    const amount = parseAmount(normalized.slice(2));
    if (!amount) {
      return null;
    }
    return { kind: 'DEPOSIT', amount };
  }

  return null;
}

function parseServiceRateInput(text: string): Decimal | null {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^(?:服务)?费率[:：=]?\s*([0-9]+(?:\.[0-9]+)?)(\s*[%％])?$/i,
  );
  if (!match) {
    return null;
  }
  try {
    const numeric = new Decimal(match[1]);
    if (numeric.lt(0)) {
      return null;
    }
    const hasPercent = match[2] ? /[%％]/.test(match[2]) : false;
    const rate = hasPercent ? numeric.div(100) : numeric;
    if (rate.lt(0)) {
      return null;
    }
    if (!hasPercent && rate.gt(1)) {
      return null;
    }
    return rate;
  } catch {
    return null;
  }
}

function formatServiceRate(rate: Decimal): string {
  const percent = rate.mul(100);
  return `${percent.toFixed(2)}% (${rate.toFixed(6)})`;
}

async function tryHandleServiceRateUpdate(
  ctx: BotContext,
): Promise<boolean> {
  const message = ctx.message;
  if (!message || !('text' in message)) {
    return false;
  }
  const text = message.text ?? '';
  const rate = parseServiceRateInput(text);
  if (!rate) {
    return false;
  }

  if (!isGroupChat(ctx) || !ctx.chat) {
    await ctx.reply('该命令仅能在群聊中使用');
    return true;
  }

  const chatId = String(ctx.chat.id);
  const chatTitle = 'title' in ctx.chat ? ctx.chat.title ?? null : null;
  const actorId = ctx.from?.id;
  const actorName = ctx.from ? getUserDisplayName(ctx.from as TelegramUser) : undefined;

  let authorized = false;
  try {
    authorized = await hasBotPermission(chatId, actorId);
  } catch {
    return true;
  }

  if (!authorized) {
    return true;
  }

  try {
    const result = await updateGroupServiceRate({
      chatId,
      chatTitle,
      serviceRate: rate,
      actorId,
      actorName,
    });

    const rows: Array<[string, string]> = [
      ['当前费率', formatServiceRate(result.nextRate)],
    ];

    if (!result.previousRate.eq(result.nextRate)) {
      rows.push(['之前费率', formatServiceRate(result.previousRate)]);
    }
    if (ctx.from) {
      rows.push(['操作人', getUserDisplayName(ctx.from as TelegramUser)]);
    }

    const formattedRows = rows
      .map(([label, value]) => {
        const safeLabel = escapeHtml(label);
        const safeValue = escapeHtml(value);
        return `• <b>${safeLabel}</b>：<code>${safeValue}</code>`;
      })
      .join('\n');

    const header = result.previousRate.eq(result.nextRate)
      ? '⚙️ 服务费率未变'
      : '⚙️ 服务费率已更新';

    await ctx.reply(
      `<b>${escapeHtml(header)}</b>\n\n${formattedRows}`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : '更新服务费率时发生未知错误';
    await ctx.reply(messageText);
  }

  return true;
}

async function handleCommand(ctx: BotContext, command: ParsedCommand) {
  const chat = ctx.chat;
  const from = ctx.from;

  if (!chat) {
    return;
  }

  const chatId = String(chat.id);
  const chatTitle = 'title' in chat ? chat.title ?? undefined : undefined;
  const actorId = from?.id;
  const actorName = from ? getUserDisplayName(from as TelegramUser) : undefined;

  const historyMarkup = buildHistoryMarkup(chatId);

  const sendReply = async (header: string, rows: Array<[string, string]>) => {
    const formattedRows = rows
      .map(([label, value]) => {
        const safeLabel = escapeHtml(label);
        const safeValue = escapeHtml(value);
    return `• <b>${safeLabel}</b>：<code>${safeValue}</code>`;
      })
      .join('\n');

    const message = `<b>${escapeHtml(header)}</b>\n\n${formattedRows}`;
    const extra = historyMarkup
      ? ({
          parse_mode: 'HTML',
          reply_markup: historyMarkup,
        } as const)
      : ({ parse_mode: 'HTML' } as const);
    await ctx.reply(message, extra);
  };

  const makeStandardRows = (values: {
    recharge: Decimal;
    deposit: Decimal;
    expense: Decimal;
    total: Decimal;
    reserveBefore: Decimal;
    reserveAfter: Decimal;
    pendingAfter: Decimal;
  }) => [
    ['本次充值', formatCurrency(values.recharge)],
    ['本次入账', formatCurrency(values.deposit)],
    ['本次出帐', formatCurrency(values.expense)],
    ['本次合计', formatCurrency(values.total)],
    ['之前备用金', formatCurrency(values.reserveBefore)],
    ['合计备用金', formatCurrency(values.reserveAfter)],
    ['合计待支付', formatCurrency(values.pendingAfter)],
  ] as Array<[string, string]>;

  let authorized = false;
  try {
    authorized = await hasBotPermission(chatId, actorId);
  } catch (error) {
    // await ctx.reply('无法验证权限，请稍后重试');
    return;
  }
  if (!authorized) {
    return;
  }

  try {
    switch (command.kind) {
      case 'PENDING_ADD': {
        const result = await addPendingAmount({
          chatId,
          chatTitle,
          amount: command.amount,
          actorId,
          actorName,
        });
        const reserveBefore = result.state.reserve.minus(result.reserveDelta);
        await sendReply(
          '📊 记录已更新',
          makeStandardRows({
            recharge: result.amount,
            deposit: ZERO,
            expense: ZERO,
            total: result.total,
            reserveBefore,
            reserveAfter: result.state.reserve,
            pendingAfter: result.state.pendingAmount,
          }),
        );
        break;
      }
      case 'REDUCE': {
        const result = await reducePendingAmount({
          chatId,
          chatTitle,
          amount: command.amount,
          actorId,
          actorName,
        });
        const reserveBefore = result.state.reserve.minus(result.reserveDelta);
        await sendReply(
          '📊 记录已更新',
          makeStandardRows({
            recharge: ZERO,
            deposit: ZERO,
            expense: result.amount,
            total: result.total,
            reserveBefore,
            reserveAfter: result.state.reserve,
            pendingAfter: result.state.pendingAmount,
          }),
        );
        break;
      }
      case 'DEPOSIT': {
        const result = await deductReserve({
          chatId,
          chatTitle,
          amount: command.amount,
          actorId,
          actorName,
        });
        const reserveBefore = result.state.reserve.minus(result.reserveDelta);
        await sendReply(
          '📊 记录已更新',
          makeStandardRows({
            recharge: ZERO,
            deposit: result.amount,
            expense: ZERO,
            total: result.total,
            reserveBefore,
            reserveAfter: result.state.reserve,
            pendingAfter: result.state.pendingAmount,
          }),
        );
        break;
      }
      default:
        break;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '处理请求时发生未知错误';
    await ctx.reply(message);
  }
}

export async function startBot() {
  async function processOperatorCommand(
    ctx: BotContext,
    action: 'add' | 'remove',
  ): Promise<void> {
    if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) {
      return;
    }
    rememberUser(String(ctx.chat.id), ctx.from as TelegramUser);
    if (!isGlobalAdmin(ctx.from.id)) {
      await ctx.reply('只有机器人管理员可以执行此命令');
      return;
    }

    const resolved = await resolveCommandTarget(ctx);
    if (!resolved.ok) {
      await ctx.reply(resolved.message);
      return;
    }

    const target = resolved.user;
    if (target.is_bot) {
      const message =
        action === 'add' ? '无法将机器人设为操作员' : '无需对机器人执行此命令';
      await ctx.reply(message);
      return;
    }

    const chatId = String(ctx.chat.id);
    const actorId = String(ctx.from.id);
    const targetId = String(target.id);
    rememberUser(chatId, target);

    if (action === 'add') {
      try {
        const created = await addGroupOperator({
          chatId,
          userId: targetId,
          userName: getUserDisplayName(target),
          assignedBy: actorId,
        });
        if (created) {
          const displayName = escapeHtml(getUserDisplayName(target));
          await ctx.reply(`已将 ${displayName} 设为本群操作员`, {
            parse_mode: 'HTML',
          });
        } else {
          await ctx.reply('该用户已经是本群操作员');
        }
      } catch {
        await ctx.reply('设置操作员失败，请稍后再试');
      }
      return;
    }

    try {
      const removed = await removeGroupOperator(chatId, targetId);
      if (removed) {
        const displayName = escapeHtml(getUserDisplayName(target));
        await ctx.reply(`已取消 ${displayName} 的操作员权限`, {
          parse_mode: 'HTML',
        });
      } else {
        await ctx.reply('该用户当前不是本群操作员');
      }
    } catch {
      await ctx.reply('取消操作员失败，请稍后再试');
    }
  }

  bot.command('operator_add', async (ctx) => {
    await processOperatorCommand(ctx, 'add');
  });
  bot.command('operator_remove', async (ctx) => {
    await processOperatorCommand(ctx, 'remove');
  });
  bot.hears(/\/operator_add\b/, async (ctx) => {
    const text = ctx.message?.text ?? '';
    if (text.trim().startsWith('/')) {
      return;
    }
    await processOperatorCommand(ctx, 'add');
  });
  bot.hears(/\/operator_remove\b/, async (ctx) => {
    const text = ctx.message?.text ?? '';
    if (text.trim().startsWith('/')) {
      return;
    }
    await processOperatorCommand(ctx, 'remove');
  });

  bot.on('text', async (ctx) => {
    if (!isGroupChat(ctx)) {
      return;
    }
    const text = ctx.message.text ?? '';
    if (ctx.chat && ctx.from) {
      rememberUser(String(ctx.chat.id), ctx.from as TelegramUser);
    }
    if (/\/operator_(add|remove)\b/.test(text)) {
      return;
    }
    const handledServiceRate = await tryHandleServiceRateUpdate(ctx);
    if (handledServiceRate) {
      return;
    }
    if (text.startsWith('/')) {
      return;
    }
    const command = parseCommand(text);
    if (!command) {
      return;
    }

    await handleCommand(ctx, command);
  });

  await bot.launch();
  // eslint-disable-next-line no-console

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
