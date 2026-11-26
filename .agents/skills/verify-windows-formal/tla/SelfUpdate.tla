---------------------------- MODULE SelfUpdate ----------------------------
EXTENDS Naturals

CONSTANTS Platforms

VARIABLES
  platform,
  step,
  liveBin,      \* "OLD", "NEW", or "MISSING"
  stagedExists, \* BOOLEAN
  bakExists,    \* BOOLEAN
  bakContent,   \* "NONE" or "OLD"
  deferred,     \* BOOLEAN
  outcome       \* "running", "ok", "failed", "double_fail"

vars == <<platform, step, liveBin, stagedExists, bakExists, bakContent, deferred, outcome>>

Init ==
  /\ platform \in Platforms
  /\ step = "init"
  /\ liveBin = "OLD"
  /\ stagedExists = FALSE
  /\ bakExists = FALSE
  /\ bakContent = "NONE"
  /\ deferred = FALSE
  /\ outcome = "running"

StageOk ==
  /\ step = "init"
  /\ stagedExists' = TRUE
  /\ step' = IF platform = "win32" THEN "ready_swap" ELSE "staged_chmod"
  /\ UNCHANGED <<platform, liveBin, bakExists, bakContent, deferred, outcome>>

StageFail ==
  /\ step = "init"
  /\ step' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<platform, liveBin, stagedExists, bakExists, bakContent, deferred>>

ChmodOk ==
  /\ step = "staged_chmod"
  /\ step' = "ready_swap"
  /\ UNCHANGED <<platform, liveBin, stagedExists, bakExists, bakContent, deferred, outcome>>

ChmodFail ==
  /\ step = "staged_chmod"
  /\ stagedExists' = FALSE
  /\ step' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<platform, liveBin, bakExists, bakContent, deferred>>

BackupRenameOk ==
  /\ step = "ready_swap"
  /\ liveBin' = "MISSING"
  /\ bakExists' = TRUE
  /\ bakContent' = "OLD"
  /\ step' = "backed_up"
  /\ UNCHANGED <<platform, stagedExists, deferred, outcome>>

BackupRenameFail ==
  /\ step = "ready_swap"
  /\ stagedExists' = FALSE
  /\ step' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<platform, liveBin, bakExists, bakContent, deferred>>

SwapRenameOk ==
  /\ step = "backed_up"
  /\ liveBin' = "NEW"
  /\ stagedExists' = FALSE
  /\ step' = "swapped"
  /\ UNCHANGED <<platform, bakExists, bakContent, deferred, outcome>>

SwapRenameFailRestoreOk ==
  /\ step = "backed_up"
  /\ stagedExists' = FALSE
  /\ liveBin' = bakContent
  /\ bakExists' = FALSE
  /\ bakContent' = "NONE"
  /\ step' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<platform, deferred>>

SwapRenameFailRestoreFail ==
  /\ step = "backed_up"
  /\ stagedExists' = FALSE
  /\ step' = "done"
  /\ outcome' = "double_fail"
  /\ UNCHANGED <<platform, liveBin, bakExists, bakContent, deferred>>

RmBakOk ==
  /\ step = "swapped"
  /\ bakExists' = FALSE
  /\ bakContent' = "NONE"
  /\ step' = "done"
  /\ outcome' = "ok"
  /\ UNCHANGED <<platform, liveBin, stagedExists, deferred>>

RmBakFailWin ==
  /\ step = "swapped"
  /\ platform = "win32"
  /\ deferred' = TRUE
  /\ step' = "done"
  /\ outcome' = "ok"
  /\ UNCHANGED <<platform, liveBin, stagedExists, bakExists, bakContent>>

RmBakFailPosix ==
  /\ step = "swapped"
  /\ platform /= "win32"
  /\ step' = "done"
  /\ outcome' = "failed"
  /\ UNCHANGED <<platform, liveBin, stagedExists, bakExists, bakContent, deferred>>

Terminated ==
  /\ step = "done"
  /\ UNCHANGED vars

Next ==
  \/ StageOk
  \/ StageFail
  \/ ChmodOk
  \/ ChmodFail
  \/ BackupRenameOk
  \/ BackupRenameFail
  \/ SwapRenameOk
  \/ SwapRenameFailRestoreOk
  \/ SwapRenameFailRestoreFail
  \/ RmBakOk
  \/ RmBakFailWin
  \/ RmBakFailPosix
  \/ Terminated

\* Invariant 1: Whenever the operation settles (except explicit double_fail which preserves .bak),
\* liveBin is ALWAYS "OLD" or "NEW" (never "MISSING").
BinaryAlwaysRecoverable ==
  step = "done" =>
    \/ liveBin \in {"OLD", "NEW"}
    \/ (outcome = "double_fail" /\ bakExists /\ bakContent = "OLD")

\* Invariant 2: A successful update ALWAYS leaves liveBin = "NEW".
SuccessImpliesNewBinary ==
  (step = "done" /\ outcome = "ok") => liveBin = "NEW"

\* Invariant 3: Deferred backup cleanup happens ONLY on win32 with liveBin = "NEW".
DeferredOnlyOnWin32 ==
  deferred => (platform = "win32" /\ liveBin = "NEW" /\ bakExists)

=============================================================================
