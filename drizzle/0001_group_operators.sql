CREATE TABLE IF NOT EXISTS "group_operators" (
  "id" serial PRIMARY KEY,
  "chat_id" text NOT NULL,
  "user_id" text NOT NULL,
  "assigned_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_operators_chat_user_idx"
  ON "group_operators" ("chat_id", "user_id");
