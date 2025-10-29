CREATE TABLE IF NOT EXISTS "group_balances" (
  "id" serial PRIMARY KEY,
  "chat_id" text NOT NULL,
  "chat_title" text,
  "reserve_balance" numeric(18, 6) NOT NULL DEFAULT '0',
  "pending_amount" numeric(18, 6) NOT NULL DEFAULT '0',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_balances_chat_id_idx"
  ON "group_balances" ("chat_id");

CREATE TABLE IF NOT EXISTS "transactions" (
  "id" serial PRIMARY KEY,
  "group_id" integer NOT NULL REFERENCES "group_balances" ("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "amount" numeric(18, 6) NOT NULL,
  "reserve_after" numeric(18, 6) NOT NULL DEFAULT '0',
  "pending_amount_after" numeric(18, 6) NOT NULL DEFAULT '0',
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "transactions_group_id_created_at_idx"
  ON "transactions" ("group_id", "created_at" DESC);
