---------------------------- MODULE DpapiStore ----------------------------
EXTENDS Naturals

VARIABLES
  diskFormat,      \* "plaintext", "sealed", "corrupt_sealed"
  wasSealed,       \* BOOLEAN (whether file on disk was ever sealed)
  memState,        \* "unloaded", "hydrated", "load_failed"
  dpapiCallsLoad,  \* 0..1
  dpapiCallsSave,  \* 0..1
  savedPlaceholders \* BOOLEAN (bug indicator: writing unhydrated __DPAPI__ to disk)

vars == <<diskFormat, wasSealed, memState, dpapiCallsLoad, dpapiCallsSave, savedPlaceholders>>

Init ==
  /\ diskFormat \in {"plaintext", "sealed", "corrupt_sealed"}
  /\ wasSealed = (diskFormat \in {"sealed", "corrupt_sealed"})
  /\ memState = "unloaded"
  /\ dpapiCallsLoad = 0
  /\ dpapiCallsSave = 0
  /\ savedPlaceholders = FALSE

LoadPlaintext ==
  /\ memState = "unloaded"
  /\ diskFormat = "plaintext"
  /\ memState' = "hydrated"
  /\ dpapiCallsLoad' = 0
  /\ UNCHANGED <<diskFormat, wasSealed, dpapiCallsSave, savedPlaceholders>>

LoadSealedOk ==
  /\ memState = "unloaded"
  /\ diskFormat = "sealed"
  /\ memState' = "hydrated"
  /\ dpapiCallsLoad' = 1
  /\ UNCHANGED <<diskFormat, wasSealed, dpapiCallsSave, savedPlaceholders>>

LoadSealedFailClosed ==
  /\ memState = "unloaded"
  /\ diskFormat \in {"sealed", "corrupt_sealed"}
  /\ memState' = "load_failed"
  /\ dpapiCallsLoad' = 1
  /\ UNCHANGED <<diskFormat, wasSealed, dpapiCallsSave, savedPlaceholders>>

SaveProtectOk ==
  /\ memState = "hydrated"
  /\ dpapiCallsSave = 0
  /\ diskFormat' = "sealed"
  /\ wasSealed' = TRUE
  /\ dpapiCallsSave' = 1
  /\ UNCHANGED <<memState, dpapiCallsLoad, savedPlaceholders>>

SaveProtectFailFirstTime ==
  /\ memState = "hydrated"
  /\ dpapiCallsSave = 0
  /\ ~wasSealed
  /\ diskFormat' = "plaintext"
  /\ dpapiCallsSave' = 1
  /\ UNCHANGED <<memState, wasSealed, dpapiCallsLoad, savedPlaceholders>>

SaveProtectFailRefuseDowngrade ==
  /\ memState = "hydrated"
  /\ dpapiCallsSave = 0
  /\ wasSealed
  \* Throws error; disk remains sealed (no downgrade).
  /\ dpapiCallsSave' = 1
  /\ UNCHANGED <<diskFormat, wasSealed, memState, dpapiCallsLoad, savedPlaceholders>>

Done ==
  /\ (memState = "load_failed" \/ dpapiCallsSave = 1)
  /\ UNCHANGED vars

Next ==
  \/ LoadPlaintext
  \/ LoadSealedOk
  \/ LoadSealedFailClosed
  \/ SaveProtectOk
  \/ SaveProtectFailFirstTime
  \/ SaveProtectFailRefuseDowngrade
  \/ Done

\* Invariant 1: At most 1 DPAPI call per load and per save.
MaxOneDpapiCall ==
  /\ dpapiCallsLoad <= 1
  /\ dpapiCallsSave <= 1

\* Invariant 2: A previously sealed file NEVER silently downgrades to plaintext.
NoSilentDowngrade ==
  wasSealed => diskFormat /= "plaintext"

\* Invariant 3: Unhydrated placeholders are NEVER written to disk.
NoPlaceholderSaved ==
  ~savedPlaceholders

=============================================================================
