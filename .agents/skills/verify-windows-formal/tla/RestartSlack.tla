---------------------------- MODULE RestartSlack ----------------------------
EXTENDS Naturals

VARIABLES
  initiallyRunning, \* BOOLEAN
  slackRunning,     \* BOOLEAN
  step,             \* "init", "stopping", "extracting", "relaunching", "done"
  workRan,          \* BOOLEAN
  stopCount,        \* 0..1
  startCount        \* 0..1

vars == <<initiallyRunning, slackRunning, step, workRan, stopCount, startCount>>

Init ==
  /\ initiallyRunning \in {TRUE, FALSE}
  /\ slackRunning = initiallyRunning
  /\ step = "init"
  /\ workRan = FALSE
  /\ stopCount = 0
  /\ startCount = 0

DirectWork ==
  /\ step = "init"
  /\ ~initiallyRunning
  /\ workRan' = TRUE
  /\ step' = "done"
  /\ UNCHANGED <<initiallyRunning, slackRunning, stopCount, startCount>>

BeginStop ==
  /\ step = "init"
  /\ initiallyRunning
  /\ stopCount' = 1
  /\ step' = "stopping"
  /\ UNCHANGED <<initiallyRunning, slackRunning, workRan, startCount>>

SlackExited ==
  /\ step = "stopping"
  /\ slackRunning' = FALSE
  /\ step' = "extracting"
  /\ UNCHANGED <<initiallyRunning, workRan, stopCount, startCount>>

StopTimeoutOrPollError ==
  /\ step = "stopping"
  /\ step' = "relaunching"
  /\ UNCHANGED <<initiallyRunning, slackRunning, workRan, stopCount, startCount>>

RunWork ==
  /\ step = "extracting"
  /\ ~slackRunning
  /\ workRan' = TRUE
  /\ step' = "relaunching"
  /\ UNCHANGED <<initiallyRunning, slackRunning, stopCount, startCount>>

Relaunch ==
  /\ step = "relaunching"
  /\ startCount' = 1
  /\ slackRunning' = TRUE
  /\ step' = "done"
  /\ UNCHANGED <<initiallyRunning, workRan, stopCount>>

Done ==
  /\ step = "done"
  /\ UNCHANGED vars

Next ==
  \/ DirectWork
  \/ BeginStop
  \/ SlackExited
  \/ StopTimeoutOrPollError
  \/ RunWork
  \/ Relaunch
  \/ Done

\* Invariant 1: Never stop or launch Slack if it was not running.
NeverStartIfNotRunning ==
  ~initiallyRunning => (stopCount = 0 /\ startCount = 0)

\* Invariant 2: If Slack was running, it is ALWAYS relaunched before finishing.
AlwaysRelaunchIfRunning ==
  (step = "done" /\ initiallyRunning) => (stopCount = 1 /\ startCount = 1)

\* Invariant 3: Extraction NEVER runs while Slack is still running (locked Cookies DB).
NoWorkWhileLocked ==
  step = "extracting" => ~slackRunning

=============================================================================
