/**
 * The credential broker is a security boundary, not a convenience wrapper.
 *
 * These tests pin the four properties the ADR requires — task scope, short
 * lifetime, explicit scopes, revocation — plus the redaction that keeps a value
 * out of the audit log.
 */

import { describe, expect, it } from 'vitest';
import { CredentialBroker } from '../../src/sandbox/credentials.ts';
import { AuditLog } from '../../src/sandbox/audit.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { Redactor } from '../../src/sandbox/redact.ts';
import { testClock } from './helpers.ts';

function setup() {
  const clock = testClock();
  const store = new MemorySandboxStore();
  const redactor = new Redactor();
  const audit = new AuditLog({ store, now: clock.now }, redactor);
  const broker = new CredentialBroker({ audit, now: clock.now, redactor, maxTtlMs: 60_000 });
  return { clock, store, redactor, audit, broker };
}

describe('credential broker', () => {
  it('issues a scoped short-lived credential as an env var', async () => {
    const { broker } = setup();
    broker.register({ credentialId: 'TEST_TOKEN', value: 'secret-value', scopes: ['read'], ttlMs: 5_000 });
    const grant = await broker.issue({
      credentialId: 'TEST_TOKEN',
      taskId: 'task-1',
      requestedScopes: ['read'],
      approvedBy: 'test',
    });
    expect(grant.taskId).toBe('task-1');
    expect(grant.scopes).toEqual(['read']);
    expect(grant.expiresAt > grant.issuedAt).toBe(true);
    const env = await broker.resolveForTask('task-1');
    expect(env.EUNOIA_CRED_TEST_TOKEN).toBe('secret-value');
    expect(await broker.resolveForTask('task-2')).toEqual({});
  });

  it('refuses an unknown credential and an unauthorized scope', async () => {
    const { broker } = setup();
    await expect(
      broker.issue({ credentialId: 'MISSING', taskId: 'task-1', approvedBy: 'test' }),
    ).rejects.toThrow(/unknown credential/);
    broker.register({ credentialId: 'TEST_TOKEN', value: 'secret-value', scopes: ['read'] });
    await expect(
      broker.issue({ credentialId: 'TEST_TOKEN', taskId: 'task-1', requestedScopes: ['write'], approvedBy: 'test' }),
    ).rejects.toThrow(/does not allow scope/);
  });

  it('drops an expired grant instead of renewing it', async () => {
    const { broker, clock } = setup();
    broker.register({ credentialId: 'TEST_TOKEN', value: 'secret-value', scopes: ['read'], ttlMs: 1_000 });
    await broker.issue({ credentialId: 'TEST_TOKEN', taskId: 'task-1', ttlMs: 1_000, approvedBy: 'test' });
    expect((await broker.resolveForTask('task-1')).EUNOIA_CRED_TEST_TOKEN).toBe('secret-value');
    clock.advance(2_000);
    expect(await broker.resolveForTask('task-1')).toEqual({});
  });

  it('revokes a grant', async () => {
    const { broker } = setup();
    broker.register({ credentialId: 'TEST_TOKEN', value: 'secret-value', scopes: ['read'] });
    const grant = await broker.issue({ credentialId: 'TEST_TOKEN', taskId: 'task-1', approvedBy: 'test' });
    expect(await broker.revoke(grant.grantId)).toBe(true);
    expect(await broker.revoke(grant.grantId)).toBe(false);
    expect(await broker.resolveForTask('task-1')).toEqual({});
  });

  it('registers the value with the shared redactor', async () => {
    const { broker, redactor } = setup();
    broker.register({ credentialId: 'TEST_TOKEN', value: 'super-secret-value', scopes: ['read'] });
    expect(redactor.redact('value=super-secret-value')).toBe('value=[redacted]');
    expect(broker.redact('super-secret-value')).toBe('[redacted]');
  });

  it('audits issuance and revocation without writing the secret', async () => {
    const { broker, store } = setup();
    broker.register({ credentialId: 'TEST_TOKEN', value: 'secret-value', scopes: ['read'] });
    const grant = await broker.issue({ credentialId: 'TEST_TOKEN', taskId: 'task-1', approvedBy: 'test' });
    await broker.revoke(grant.grantId);
    const audit = await store.listAudit(20);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(['credential.issue', 'credential.revoke']),
    );
    expect(JSON.stringify(audit)).not.toContain('secret-value');
  });
});
