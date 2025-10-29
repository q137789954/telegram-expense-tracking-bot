import { z } from 'zod';

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SERVICE_RATE: z.string().optional(),
  BOT_ADMINS: z.string().min(1, 'BOT_ADMINS is required'),
  // 允许在开发环境省略链接，从而关闭“查看历史账单”按钮。
  PUBLIC_APP_URL: z.string().url('PUBLIC_APP_URL must be a valid URL').optional(),
  PORT: z
    .string()
    .optional()
    .transform((value) => (value ? Number.parseInt(value, 10) : undefined))
    .refine((value) => (value ? Number.isFinite(value) && value > 0 : true), {
      message: 'PORT must be a positive integer',
    }),
});

const rawEnv = envSchema.parse(process.env);
const botAdminIds = parseAdminIds(rawEnv.BOT_ADMINS);

function parseAdminIds(raw: string): string[] {
  const tokens = raw
    .split(/[,，\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    throw new Error('BOT_ADMINS must contain at least one Telegram user id');
  }

  const invalid = tokens.filter((id) => !/^-?\d+$/.test(id));
  if (invalid.length > 0) {
    throw new Error(
      `BOT_ADMINS must contain numeric Telegram user ids, invalid value(s): ${invalid.join(
        ', ',
      )}`,
    );
  }

  return Array.from(new Set(tokens));
}

function parseServiceRate(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const cleaned = raw.trim();
  if (!cleaned) {
    return 0;
  }

  // 支持输入 “0.03%” 或 “0.0003” 等格式，方便运维按照习惯填写。
  const percentMatch = cleaned.match(/^([0-9]*\.?[0-9]+)\s*%$/);
  if (percentMatch) {
    const percentValue = Number.parseFloat(percentMatch[1]);
    if (!Number.isFinite(percentValue)) {
      throw new Error(`Invalid SERVICE_RATE value: ${cleaned}`);
    }
    return percentValue / 100;
  }

  const numericValue = Number.parseFloat(cleaned);
  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid SERVICE_RATE value: ${cleaned}`);
  }
  return numericValue;
}

export const env = {
  botToken: rawEnv.BOT_TOKEN,
  databaseUrl: rawEnv.DATABASE_URL,
  serviceRate: parseServiceRate(rawEnv.SERVICE_RATE),
  botAdminIds,
  botAdminIdSet: new Set(botAdminIds),
  // 仅在用户显式配置时才返回公网地址，并去掉末尾多余的斜杠。
  publicAppUrl: rawEnv.PUBLIC_APP_URL
    ? rawEnv.PUBLIC_APP_URL.replace(/\/+$/, '')
    : undefined,
  port: rawEnv.PORT ?? 3000,
};
