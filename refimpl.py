#!/usr/bin/env python3
"""Reference impl for: rt-emailsync-imap-configurable

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/emailSync.ts'
t = p.read_text()

# 1) Widen EmailCredentials with the four optional fields (defaults live at use-site).
OLD_TYPE = r"""export type EmailCredentials = { address: string; appPassword: string };"""
NEW_TYPE = r"""export type EmailCredentials = { address: string; appPassword: string; host?: string; port?: number; secure?: boolean; mailbox?: string };"""

# 2) fetchOrderEmails's ImapFlow config is the FIRST of three identical blocks in
#    file order (fetchOrderEmails, deleteEmail, deleteEmails). Replace only that
#    first occurrence so deleteEmail/deleteEmails keep their hardcoded literals.
OLD_CFG = r"""export async function fetchOrderEmails(creds: EmailCredentials, since?: Date): Promise<ParsedEmailOrder[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,"""
NEW_CFG = r"""export async function fetchOrderEmails(creds: EmailCredentials, since?: Date): Promise<ParsedEmailOrder[]> {
  const client = new ImapFlow({
    host: creds.host ?? 'imap.gmail.com',
    port: creds.port ?? 993,
    secure: creds.secure ?? true,"""

# 3) fetchOrderEmails's mailbox lock is the FIRST getMailboxLock('INBOX') in file order.
OLD_LOCK = r"""    lock = await client.getMailboxLock('INBOX');"""
NEW_LOCK = r"""    lock = await client.getMailboxLock(creds.mailbox ?? 'INBOX');"""

assert OLD_TYPE in t, "refimpl anchor (type) not found -- did the target change?"
t = t.replace(OLD_TYPE, NEW_TYPE, 1)
assert OLD_CFG in t, "refimpl anchor (fetchOrderEmails config) not found -- did the target change?"
t = t.replace(OLD_CFG, NEW_CFG, 1)
assert OLD_LOCK in t, "refimpl anchor (mailbox lock) not found -- did the target change?"
t = t.replace(OLD_LOCK, NEW_LOCK, 1)

p.write_text(t)
print("refimpl applied")
