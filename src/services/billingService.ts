import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { groupBalances, transactions } from '../db/schema.js';

// 系统统一使用 Decimal 计算，避免浮点误差。
const SCALE = 6;

type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface GroupState {
  id: number;
  reserve: Decimal;
  pendingAmount: Decimal;
  serviceRate: Decimal;
}

interface OperationContext {
  chatId: string;
  chatTitle?: string | null;
  amount: Decimal;
  actorId?: number;
}

export interface OperationResult {
  message: string;
  state: GroupState;
  amount: Decimal;
  serviceFee: Decimal;
  total: Decimal;
  rechargePrincipal: Decimal;
  pendingBefore: Decimal;
  reserveDelta: Decimal;
}

interface ServiceRateUpdateContext {
  chatId: string;
  chatTitle?: string | null;
  serviceRate: Decimal;
  actorId?: number;
}

function toDecimal(value: string | null | undefined): Decimal {
  if (value == null) {
    return new Decimal(0);
  }
  return new Decimal(value);
}

function toDbString(value: Decimal): string {
  // 使用统一的小数位数写入数据库，避免 PostgreSQL numeric 精度不一致。
  return value.toFixed(SCALE);
}

function calculateTotals(amount: Decimal, serviceRate: Decimal) {
  const serviceFee = amount.mul(serviceRate);
  const total = amount.plus(serviceFee);
  return { serviceFee, total };
}

async function ensureGroup(
  tx: TxClient,
  chatId: string,
  chatTitle?: string | null,
): Promise<GroupState> {
  // 利用 UPSERT 机制确保群组记录存在，便于后续逻辑直接读取。
  await tx
    .insert(groupBalances)
    .values({
      chatId,
      chatTitle: chatTitle ?? null,
    })
    .onConflictDoUpdate({
      target: groupBalances.chatId,
      set: {
        chatTitle: chatTitle ?? null,
        updatedAt: new Date(),
      },
    });

  const group = await tx.query.groupBalances.findFirst({
    where: eq(groupBalances.chatId, chatId),
  });

  if (!group) {
    throw new Error(`Unable to load group for chatId=${chatId}`);
  }

  return {
    id: group.id,
    reserve: toDecimal(group.reserveBalance),
    pendingAmount: toDecimal(group.pendingAmount),
    serviceRate: toDecimal(group.serviceRate),
  };
}

async function saveState(
  tx: TxClient,
  groupId: number,
  state: GroupState,
): Promise<void> {
  // 在同一事务中更新群组余额聚合字段，确保读写一致。
  await tx
    .update(groupBalances)
    .set({
      reserveBalance: toDbString(state.reserve),
      pendingAmount: toDbString(state.pendingAmount),
      updatedAt: new Date(),
    })
    .where(eq(groupBalances.id, groupId));
}

async function recordTransaction(
  tx: TxClient,
  group: GroupState,
  type: string,
  amount: Decimal,
  note?: string,
) {
  // 追加不可变的流水记录，用于审计与历史查询。
  await tx.insert(transactions).values({
    groupId: group.id,
    type,
    amount: toDbString(amount),
    reserveAfter: toDbString(group.reserve),
    pendingAmountAfter: toDbString(group.pendingAmount),
    note: note ?? null,
  });
}

export async function addPendingAmount(
  context: OperationContext,
): Promise<OperationResult> {
  return db.transaction(async (tx) => {
    const group = await ensureGroup(tx, context.chatId, context.chatTitle);
    const pendingBefore = group.pendingAmount;
    const reserveBefore = group.reserve;
    const spendAmount = context.amount;
    const { serviceFee, total } = calculateTotals(
      spendAmount,
      group.serviceRate,
    );
    let rechargePrincipal = new Decimal(0);
    let note: string;

    if (total.gte(0)) {
      const reserveUsed = Decimal.min(reserveBefore, total);
      const pendingIncrease = total.minus(reserveUsed);
      rechargePrincipal = Decimal.max(spendAmount.minus(reserveUsed), 0);

      group.reserve = reserveBefore.minus(reserveUsed);
      group.pendingAmount = pendingBefore.plus(pendingIncrease);

      const rechargeSummary = `需充值本金 ${rechargePrincipal.toFixed(
        SCALE,
      )}，手续费 ${serviceFee.toFixed(SCALE)}，合计 ${total.toFixed(SCALE)}`;
      const reserveSummary = `使用备用金 ${reserveUsed.toFixed(
        SCALE,
      )}，新增待支付 ${pendingIncrease.toFixed(SCALE)}`;

      note = `管理员 ${context.actorId ?? '未知'} 消费 ${spendAmount.toFixed(
        SCALE,
      )}（${reserveSummary}；${rechargeSummary}）`;
    } else {
      const credit = total.neg();
      const pendingReduction = Decimal.min(pendingBefore, credit);
      const reserveIncrease = credit.minus(pendingReduction);

      group.pendingAmount = pendingBefore.minus(pendingReduction);
      group.reserve = reserveBefore.plus(reserveIncrease);

      const summaryParts = [
        `冲减待支付 ${pendingReduction.toFixed(SCALE)}`,
      ];
      if (reserveIncrease.gt(0)) {
        summaryParts.push(`增加备用金 ${reserveIncrease.toFixed(SCALE)}`);
      }
      summaryParts.push(`手续费 ${serviceFee.toFixed(SCALE)}`);
      summaryParts.push(`合计 ${total.toFixed(SCALE)}`);

      const actionLabel = spendAmount.lt(0) ? '调整' : '消费';
      note = `管理员 ${context.actorId ?? '未知'} ${actionLabel} ${spendAmount.toFixed(
        SCALE,
      )}（${summaryParts.join('，')}）`;
    }

    await saveState(tx, group.id, group);
    await recordTransaction(
      tx,
      group,
      'PENDING_ADD',
      spendAmount,
      note,
    );

    const reserveDelta = group.reserve.minus(reserveBefore);

    return {
      message: '',
      state: group,
      amount: spendAmount,
      serviceFee,
      total,
      rechargePrincipal,
      pendingBefore,
      reserveDelta,
    };
  });
}

export async function reducePendingAmount(
  context: OperationContext,
): Promise<OperationResult> {
  return db.transaction(async (tx) => {
    const group = await ensureGroup(tx, context.chatId, context.chatTitle);
    const pendingBefore = group.pendingAmount;
    const payment = context.amount;
    const appliedToPending = Decimal.min(pendingBefore, payment);
    const pendingAfter = pendingBefore.minus(appliedToPending);
    const overpay = payment.minus(appliedToPending);

    group.pendingAmount = pendingAfter;
    if (overpay.gt(0)) {
      group.reserve = group.reserve.plus(overpay);
    }

    await saveState(tx, group.id, group);
    await recordTransaction(
      tx,
      group,
      'PENDING_REDUCE',
      payment,
      `管理员 ${context.actorId ?? '未知'} 充值 ${payment.toFixed(
        SCALE,
      )}（抵扣待充值 ${appliedToPending.toFixed(
        SCALE,
      )}，转入备用金 ${overpay.toFixed(
        SCALE,
      )}，剩余待充值 ${pendingAfter.toFixed(SCALE)}）`,
    );

    return {
      message: '',
      state: group,
      amount: payment,
      serviceFee: new Decimal(0),
      total: payment.negated(),
      rechargePrincipal: new Decimal(0),
      pendingBefore,
      reserveDelta: overpay,
    };
  });
}

export async function addReserve(
  context: OperationContext,
): Promise<OperationResult> {
  return db.transaction(async (tx) => {
    const group = await ensureGroup(tx, context.chatId, context.chatTitle);
    const pendingBefore = group.pendingAmount;
    const { serviceFee, total } = calculateTotals(
      context.amount,
      group.serviceRate,
    );

    if (group.pendingAmount.lessThan(total)) {
      throw new Error('待支付金额不足，无法入账');
    }

    group.reserve = group.reserve.plus(context.amount);
    group.pendingAmount = group.pendingAmount.minus(total);

    await saveState(tx, group.id, group);
    await recordTransaction(
      tx,
      group,
      'DEPOSIT',
      context.amount,
      `管理员 ${context.actorId ?? '未知'} 入账（本金 ${context.amount.toFixed(
        SCALE,
      )}，扣除待支付 ${total.toFixed(SCALE)}）`,
    );

    return {
      message: '',
      state: group,
      amount: context.amount,
      serviceFee,
      total,
      rechargePrincipal: new Decimal(0),
      pendingBefore,
      reserveDelta: context.amount,
    };
  });
}

export async function deductReserve(
  context: OperationContext,
): Promise<OperationResult> {
  return db.transaction(async (tx) => {
    const group = await ensureGroup(tx, context.chatId, context.chatTitle);
    const pendingBefore = group.pendingAmount;
    const reserveBefore = group.reserve;
    const usage = context.amount;
    const reserveAfter = reserveBefore.minus(usage);
    let pendingIncrease = new Decimal(0);
    let rechargePrincipal = new Decimal(0);
    let serviceFee = new Decimal(0);

    if (reserveAfter.gte(0)) {
      group.reserve = reserveAfter;
    } else {
      rechargePrincipal = reserveAfter.neg();
      if (rechargePrincipal.gt(0)) {
        pendingIncrease = rechargePrincipal;
      }
      group.reserve = new Decimal(0);
      group.pendingAmount = group.pendingAmount.plus(pendingIncrease);
    }

    const reserveUsed = Decimal.min(reserveBefore, usage);

    await saveState(tx, group.id, group);
    await recordTransaction(
      tx,
      group,
      'DEPOSIT',
      usage,
      `管理员 ${context.actorId ?? '未知'} 使用 ${usage.toFixed(
        SCALE,
      )}（备用金扣减 ${reserveUsed.toFixed(
        SCALE,
      )}，新增待充值 ${pendingIncrease.toFixed(
        SCALE,
      )}，其中本金 ${rechargePrincipal.toFixed(SCALE)}）`,
    );

    return {
      message: '',
      state: group,
      amount: usage,
      serviceFee,
      total: usage,
      rechargePrincipal: new Decimal(0),
      pendingBefore,
      reserveDelta: group.reserve.minus(reserveBefore),
    };
  });
}

export async function ensureGroupInitialized(
  chatId: string,
  chatTitle?: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureGroup(tx, chatId, chatTitle);
  });
}

export async function updateGroupServiceRate(
  context: ServiceRateUpdateContext,
): Promise<{ previousRate: Decimal; nextRate: Decimal }> {
  return db.transaction(async (tx) => {
    const group = await ensureGroup(tx, context.chatId, context.chatTitle);
    const previousRate = group.serviceRate;
    const nextRate = context.serviceRate;

    if (previousRate.eq(nextRate)) {
      return { previousRate, nextRate };
    }

    group.serviceRate = nextRate;

    await tx
      .update(groupBalances)
      .set({
        serviceRate: toDbString(nextRate),
        chatTitle: context.chatTitle ?? null,
        updatedAt: new Date(),
      })
      .where(eq(groupBalances.id, group.id));

    const zero = new Decimal(0);
    await recordTransaction(
      tx,
      group,
      'SERVICE_RATE_UPDATE',
      zero,
      `管理员 ${context.actorId ?? '未知'} 将服务费率从 ${previousRate.toFixed(
        SCALE,
      )} 调整为 ${nextRate.toFixed(SCALE)}`,
    );

    return { previousRate, nextRate };
  });
}
