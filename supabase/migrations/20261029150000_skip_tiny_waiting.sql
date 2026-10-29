-- Card checks and test sends of GH₵1 or less are no longer asked about.
update public.bank_messages set status = 'skipped' where status = 'needs_label' and amount <= 1;
