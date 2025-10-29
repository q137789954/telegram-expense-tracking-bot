import { relations } from 'drizzle-orm';
import {
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const groupBalances = pgTable(
  'group_balances',
  {
    // 群组基础信息及汇总数据。
    id: serial('id').primaryKey(),
    // Telegram 群组 ID，字符串形式。
    chatId: text('chat_id').notNull(),
    // 群名称，可为空。
    chatTitle: text('chat_title'),
    // 当前备用金余额。
    reserveBalance: numeric('reserve_balance', { precision: 18, scale: 6 })
      .notNull()
      .default('0'),
    // 当前服务费率（以小数表示，例如 0.03 表示 3%）。
    serviceRate: numeric('service_rate', { precision: 10, scale: 6 })
      .notNull()
      .default('0'),
    // 待支付总额（含手续费）。
    pendingAmount: numeric('pending_amount', { precision: 18, scale: 6 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chatIdIdx: uniqueIndex('group_balances_chat_id_idx').on(table.chatId),
  }),
);

export const groupOperators = pgTable(
  'group_operators',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name'),
    assignedBy: text('assigned_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chatUserIdx: uniqueIndex('group_operators_chat_user_idx').on(
      table.chatId,
      table.userId,
    ),
  }),
);

export const transactions = pgTable('transactions', {
  // 每条操作流水。
  id: serial('id').primaryKey(),
  groupId: integer('group_id')
    .notNull()
    .references(() => groupBalances.id),
  // 操作类型：PENDING_ADD / DEPOSIT 等。
  type: text('type').notNull(),
  // 本次操作涉及的本金金额。
  amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
  // 操作后的备用金余额快照。
  reserveAfter: numeric('reserve_after', { precision: 18, scale: 6 })
    .notNull()
    .default('0'),
  // 操作后的待支付余额快照。
  pendingAmountAfter: numeric('pending_amount_after', {
    precision: 18,
    scale: 6,
  })
    .notNull()
    .default('0'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const groupBalanceRelations = relations(groupBalances, ({ many }) => ({
  transactions: many(transactions),
}));

export const transactionRelations = relations(transactions, ({ one }) => ({
  // 流水反向关联群组，便于联表查询。
  group: one(groupBalances, {
    fields: [transactions.groupId],
    references: [groupBalances.id],
  }),
}));

export type GroupBalance = typeof groupBalances.$inferSelect;
export type NewGroupBalance = typeof groupBalances.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type GroupOperator = typeof groupOperators.$inferSelect;
export type NewGroupOperator = typeof groupOperators.$inferInsert;
