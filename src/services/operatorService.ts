import { and, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { groupOperators } from '../db/schema.js';

interface OperatorContext {
  chatId: string;
  userId: string;
  userName?: string | null;
  assignedBy?: string | null;
}

export async function isGroupOperator(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const record = await db.query.groupOperators.findFirst({
    where: and(eq(groupOperators.chatId, chatId), eq(groupOperators.userId, userId)),
  });
  return Boolean(record);
}

export async function addGroupOperator(context: OperatorContext): Promise<boolean> {
  const inserted = await db
    .insert(groupOperators)
    .values({
      chatId: context.chatId,
      userId: context.userId,
      userName: context.userName ?? null,
      assignedBy: context.assignedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: groupOperators.id });

  return inserted.length > 0;
}

export async function removeGroupOperator(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(groupOperators)
    .where(and(eq(groupOperators.chatId, chatId), eq(groupOperators.userId, userId)))
    .returning({ id: groupOperators.id });

  return deleted.length > 0;
}
