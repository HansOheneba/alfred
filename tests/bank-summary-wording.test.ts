import { describe, expect, it } from 'vitest';
import { applyLabel, ingestBankText, type IngestOutcome, type Label } from '@/lib/bank/ingest';
import { summarize } from '@/lib/bank/notify';
import { MemoryBankStore } from '@/lib/bank/store';
import { MemoryFinanceStore } from '@/lib/finance/memory-store';
import { profile } from './helpers';

async function excluded(label: Label): Promise<IngestOutcome> {
  const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore(), owner = profile(42);
  const deps = { bank, ledger, now: new Date('2026-11-03T12:00:00Z'), createId: () => '11111111-1111-4111-8111-111111111111' };
  const text = 'Payment made for GHS 1.00 to FICTIONAL PERSON Current Balance: GHS 99.00. Available Balance: GHS 99.00. Reference: . Transaction ID: 92312345678. Fee charged: GHS0.00 Tax charged: 0.';
  const received = await ingestBankText(deps, owner, text, { channel: 'mac' });
  const outcome = received.outcomes[0];
  expect(outcome.outcome).toBe('needs_label');
  // Old skipped records remain readable; current payment questions cannot create
  // a new skip. Rehearse history directly without invoking the removed action.
  if (label.kind === 'skip') await bank.updateMessage(owner.profileId, outcome.message.id, { status: 'skipped' });
  else expect((await applyLabel(deps, owner, outcome.message.id, label)).ok).toBe(true);
  expect(await ledger.listTransactions(owner.profileId)).toEqual([]);
  const message = await bank.getMessage(owner.profileId, outcome.message.id);
  expect(message?.status).toBe('skipped');
  return { ...outcome, outcome: 'skipped', message: message! };
}

describe('neutral summaries of historical exclusions and explicit pass-through records', () => {
  it.each([{ kind: 'skip' }, { kind: 'pass_through' }] as Label[])('does not invent a test charge after $kind', async label => {
    const lines = summarize([await excluded(label)], 'GHS');
    expect(lines).toEqual(['Left out GH₵1.00 to Fictional Person.']);
    expect(lines.join(' ')).not.toMatch(/card check|test send|test charge|tiny/i);
  });
  it('counts excluded payments neutrally in a larger summary', async () => {
    const outcome = await excluded({ kind: 'skip' });
    const lines = summarize(Array.from({ length: 4 }, () => outcome), 'GHS');
    expect(lines).toEqual(['I read 4 new payments: 4 payments left out.']);
    expect(lines.join(' ')).not.toMatch(/card check|test send|test charge|tiny/i);
  });
});
