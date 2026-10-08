import { pgSchema,uuid,text,timestamp,integer,bigint,jsonb,primaryKey,unique,index } from 'drizzle-orm/pg-core';
import { bytea } from './columns';
const m4=pgSchema('finnor_os');
const scope=()=>({tenantId:uuid('tenant_id').notNull(),principalId:uuid('principal_id').notNull(),searchId:uuid('search_id').notNull()});
/** SQL migration owns constraints, immutable transitions, encryption retention and ordinary-principal RLS. */
export const m4Searches=m4.table('m4_searches',{
  id:uuid('id').notNull(),tenantId:uuid('tenant_id').notNull(),principalId:uuid('principal_id').notNull(),
  workId:uuid('work_id').notNull(),workInputId:uuid('work_input_id').notNull(),workInputDigest:text('work_input_digest').notNull(),
  idempotencyKey:text('idempotency_key').notNull(),requestDigest:text('request_digest').notNull(),frozenDigest:text('frozen_digest').notNull(),
  reportDigest:text('report_digest'),parentSearchId:uuid('parent_search_id'),limits:jsonb('limits').notNull(),status:text('status').notNull().default('QUEUED'),
  jobId:uuid('job_id'),activeClaimToken:uuid('active_claim_token'),activeClaimFence:bigint('active_claim_fence',{mode:'number'}),
  trials:integer('trials').notNull().default(0),retainedBytes:bigint('retained_bytes',{mode:'number'}).notNull().default(0),
  deadlineAt:timestamp('deadline_at',{withTimezone:true}).notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.principalId,t.id]}),unique('m4_searches_principal_idempotency').on(t.tenantId,t.principalId,t.idempotencyKey)]);
export const m4Records=m4.table('m4_records',{...scope(),digest:text('digest').notNull(),kind:text('kind').notNull(),
  plaintextBytes:integer('plaintext_bytes').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.principalId,t.searchId,t.digest]})]);
export const m4Payloads=m4.table('m4_payloads',{...scope(),digest:text('digest').notNull(),keyId:text('key_id').notNull(),
  nonce:bytea('nonce').notNull(),tag:bytea('tag').notNull(),ciphertext:bytea('ciphertext').notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.principalId,t.searchId,t.digest]}),index('m4_payload_retention_idx').on(t.tenantId,t.principalId,t.expiresAt)]);
export const m4Events=m4.table('m4_events',{...scope(),id:uuid('id').notNull().defaultRandom(),attemptId:uuid('attempt_id'),
  kind:text('kind').notNull(),recordDigest:text('record_digest').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.principalId,t.id]}),index('m4_events_search_idx').on(t.tenantId,t.principalId,t.searchId,t.createdAt,t.id)]);
export const m4Allocations=m4.table('m4_allocations',{
  tenantId:uuid('tenant_id').notNull(),principalId:uuid('principal_id').notNull(),rootSearchId:uuid('root_search_id').notNull(),
  kind:text('kind').notNull(),allocationKey:text('allocation_key').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.principalId,t.rootSearchId,t.kind,t.allocationKey]})]);
