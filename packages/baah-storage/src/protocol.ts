/**
 * The worker RPC protocol.
 *
 * Every message that crosses `postMessage` is untrusted, so every message is a
 * zod schema (`AGENTS.md` §5). The worker parses requests and answers with
 * exactly one correlated response; the client parses the response envelope
 * again before it trusts the payload.
 */

import { z } from "zod";

import type { StorageErrorCode } from "./errors.ts";

/** Correlation id. `crypto.randomUUID()` on both sides. */
const correlationId = z.string().min(1);

/** Booleans become `0`/`1` and blobs stay blobs — both are bindable as-is. */
export const sqlParamSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
]);

export const sqlParamsSchema = z.array(sqlParamSchema).max(64);

/** The four modes `drizzle-orm/sqlite-proxy` asks for. */
export const sqlMethodSchema = z.enum(["run", "all", "values", "get"]);

const isoTimestamp = z.string().min(1);

const partTypeSchema = z.enum(["text", "reasoning", "tool"]);

const messageRoleSchema = z.enum([
  "user",
  "assistant",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "idle",
  "agent-switched",
  "model-switched",
  "location-switched",
]);

const sessionStatusSchema = z.enum(["active", "archived"]);

const streamStatusSchema = z.enum([
  "pending",
  "running",
  "streaming",
  "completed",
  "failed",
  "aborted",
]);

const turnOutcomeSchema = z.enum(["succeeded", "failed", "interrupted"]);

const jsonText = z.string().nullable();

/* ------------------------------------------------------------------ */
/* Requests                                                             */
/* ------------------------------------------------------------------ */

/**
 * Request objects are `strict`: an unexpected key is a bug in the caller, and
 * silently dropping it would let a mistyped field look like a working call.
 * (A `params` array next to the payload instead of inside it, for instance,
 * would otherwise run the statement without its bindings.)
 */
export const openRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("open"),
  payload: z.strictObject({
    filename: z.string().min(1),
    vfsName: z.string().min(1).optional(),
    directory: z.string().min(1).optional(),
  }),
});

export const queryRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("query"),
  payload: z.strictObject({
    sql: z.string().min(1),
    params: sqlParamsSchema.default([]),
    method: sqlMethodSchema,
  }),
});

export const runRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("run"),
  payload: z.strictObject({
    sql: z.string().min(1),
    params: sqlParamsSchema.default([]),
  }),
});

export const statementSchema = z.strictObject({
  sql: z.string().min(1),
  params: sqlParamsSchema.default([]),
});

export const txRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("tx"),
  payload: z.strictObject({
    statements: z.array(statementSchema).min(1).max(512),
  }),
});

export const searchRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("search"),
  payload: z.strictObject({
    query: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    // Any integer, deliberately. The range is enforced once, in the shared
    // `clampSearchLimit()`; a bound here would make the worker reject a limit
    // the in-memory backend quietly clamps, and the two backends would then
    // answer the same query differently.
    limit: z.number().int().default(50),
  }),
});

/** The part projection a flush writes. Missing fields are filled in by the store. */
export const partInputSchema = z.strictObject({
  id: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1),
  type: partTypeSchema,
  contentText: z.string(),
  updatedAt: isoTimestamp,
  seq: z.number().int().min(0).optional(),
  data: jsonText.optional(),
  status: streamStatusSchema.nullable().optional(),
  createdAt: isoTimestamp.optional(),
});

export const flushDeltaRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("flushDelta"),
  payload: z.strictObject({
    deltaId: z.string().min(1),
    part: partInputSchema,
    flushedAt: isoTimestamp,
  }),
});

export const closeRequestSchema = z.strictObject({
  id: correlationId,
  kind: z.literal("close"),
  payload: z.strictObject({}),
});

export const rpcRequestSchema = z.discriminatedUnion("kind", [
  openRequestSchema,
  queryRequestSchema,
  runRequestSchema,
  txRequestSchema,
  searchRequestSchema,
  flushDeltaRequestSchema,
  closeRequestSchema,
]);

export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcRequestKind = RpcRequest["kind"];
export type OpenRequest = z.infer<typeof openRequestSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type TxRequest = z.infer<typeof txRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type FlushDeltaRequest = z.infer<typeof flushDeltaRequestSchema>;
export type CloseRequest = z.infer<typeof closeRequestSchema>;

/* ------------------------------------------------------------------ */
/* Responses                                                            */
/* ------------------------------------------------------------------ */

const storageErrorCodeSchema = z.enum([
  "invalid_message",
  "database_owned_by_another_context",
  "database_already_open",
  "database_not_open",
  "database_closed",
  "sql_error",
  "nested_transaction",
  "unsupported",
  "internal",
]);

export const storageErrorPayloadSchema = z.object({
  code: storageErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.string()),
});

export type SerializedStorageError = z.infer<typeof storageErrorPayloadSchema> & {
  code: StorageErrorCode;
};

export const rpcResponseSchema = z.object({
  id: correlationId,
  /** Echoes the request `kind` so a late response cannot answer the wrong call. */
  kind: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: storageErrorPayloadSchema.optional(),
});

export type RpcResponse = z.infer<typeof rpcResponseSchema>;

/* ------------------------------------------------------------------ */
/* Result payloads                                                      */
/* ------------------------------------------------------------------ */

export const openResultSchema = z.object({
  filename: z.string(),
  vfsName: z.string(),
  sqliteVersion: z.string(),
  schemaVersion: z.number().int().min(0),
});

export const queryResultSchema = z.object({
  rows: z.array(z.unknown()),
  changes: z.number().int(),
});

export const runResultSchema = z.object({
  changes: z.number().int(),
});

export const txResultSchema = z.object({
  changes: z.number().int(),
  results: z.array(z.unknown()),
});

export const searchHitSchema = z.object({
  partId: z.string(),
  messageId: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  type: partTypeSchema,
  createdAt: z.string(),
  score: z.number(),
  excerpt: z.string(),
});

export const searchResultSchema = z.object({
  hits: z.array(searchHitSchema),
});

export const flushDeltaResultSchema = z.object({
  partId: z.string(),
  deltaId: z.string(),
  applied: z.boolean(),
  deltaSeq: z.number().int().min(0),
});

export const closeResultSchema = z.object({
  closed: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Row projections (snake_case columns aliased to camelCase by the SQL)  */
/* ------------------------------------------------------------------ */

export const sessionRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: sessionStatusSchema,
  model: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

export const messageRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  parentId: z.string().nullable(),
  seq: z.number().int(),
  role: messageRoleSchema,
  status: streamStatusSchema.nullable(),
  model: z.string().nullable(),
  outcome: turnOutcomeSchema.nullable(),
  error: z.string().nullable(),
  usage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const partRowSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  type: partTypeSchema,
  data: z.string().nullable(),
  contentText: z.string(),
  status: streamStatusSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;
export type MessageRow = z.infer<typeof messageRowSchema>;
export type PartRow = z.infer<typeof partRowSchema>;
