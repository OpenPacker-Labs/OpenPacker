# Lifecycle and policy

Lifecycle reduction is a pure function of events, target, evaluation time, and
authority rules. Events sort by effective time, subject specificity, issue time,
then event ID. Future, expired, unauthorized, and mismatched events remain in
history but cannot alter state. A deny is not cleared by a later publish; only a
later authorized `restored` event restores eligibility.

Default resolution excludes yanked, quarantined, revoked, and delisted releases;
deprecated releases remain eligible with a warning. Exact forensic digest use is
a separate explicit policy decision.

Evidence facts retain `valid`, `invalid`, `not-provided`, `unknown`,
`not-applicable`, and `policy-denied`. The aggregate decision is separate:
invalid or denied evidence yields deny, required missing or unknown evidence
yields indeterminate, and otherwise policy allows. The canonical policy digest
is bound into every receipt.
