-- What the supplier is actually holding.
--
-- The app sends the supplier nothing. The PO PDF is built in the browser
-- (src/client/lib/po-pdf.ts) and emailed by a person; "Mark as issued to
-- supplier" is that person ticking a box afterwards. So `issued_at` records a
-- claim about the outside world, not an action the app took.
--
-- Amending an issued order now sends it back for approval and clears
-- `issued_at` (see amendSendsBackForApproval). That is right, but it leaves the
-- order indistinguishable from one that was never sent at all — and the two
-- need opposite things done about them. One needs sending. The other needs
-- sending AGAIN, to a supplier who is sitting on a copy that says something
-- else, and who will deliver against it.
--
-- These three columns keep the outside world separate from our own workflow:
--
--   supplier_copy_issued_at   when the copy they hold went out. Survives an
--                             amendment — that is the whole point.
--   supplier_copy_value       the order total printed on that copy, so the app
--                             can say what they think they are owed. NULL when
--                             we genuinely don't know.
--   supplier_copy_stale_since when we amended past that copy. NULL means they
--                             hold the current version.
ALTER TABLE purchase_orders ADD COLUMN supplier_copy_issued_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN supplier_copy_value REAL;
ALTER TABLE purchase_orders ADD COLUMN supplier_copy_stale_since TEXT;

-- Backfill from the audit trail, which has recorded every issue and every edit
-- all along. The two DEMO orders predate their own audit rows, so fall back to
-- issued_at.
UPDATE purchase_orders
   SET supplier_copy_issued_at = COALESCE(
         (SELECT MAX(a.created_at) FROM audit_log a
           WHERE a.entity_type = 'po' AND a.entity_id = purchase_orders.id AND a.action = 'issued'),
         issued_at)
 WHERE issued_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM audit_log a
                WHERE a.entity_type = 'po' AND a.entity_id = purchase_orders.id AND a.action = 'issued');

-- Amended after it went out: the copy they hold is stale, and its value is a
-- figure nobody recorded at the time. Left NULL rather than guessed — the UI
-- says "we don't have a record of what they hold" instead of asserting a
-- number that would be wrong.
--
-- This marks five live orders on the day it runs: PO-26001-0013 (8 amendments
-- after issue), PO-26002-0004 (7), PO-26003-0012 (7), PO-25008-0001 (1) and
-- PO-25008-0002 (1). They have been in that state for months with nothing
-- saying so; the backfill is how anyone finds out.
UPDATE purchase_orders
   SET supplier_copy_stale_since = (
         SELECT MAX(a.created_at) FROM audit_log a
          WHERE a.entity_type = 'po' AND a.entity_id = purchase_orders.id
            AND a.action = 'edited' AND a.created_at > purchase_orders.supplier_copy_issued_at)
 WHERE supplier_copy_issued_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM audit_log a
                WHERE a.entity_type = 'po' AND a.entity_id = purchase_orders.id
                  AND a.action = 'edited' AND a.created_at > purchase_orders.supplier_copy_issued_at);

-- Not amended since it went out, so the copy they hold is this order as it
-- stands. Safe to record the current total against it.
UPDATE purchase_orders
   SET supplier_copy_value = total_value
 WHERE supplier_copy_issued_at IS NOT NULL
   AND supplier_copy_stale_since IS NULL;
