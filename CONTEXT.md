# Notes

## Task routines

**Predecessor**:
The task whose completion makes a follow-up available.
_Avoid_: Parent (tasks need not be nested)

**Follow-up**:
A task that waits for a predecessor's completion. Each new completion of a repeating predecessor can make it available again.
_Avoid_: Subtask (the relationship expresses order, not containment)

**Occurrence**:
One scheduled instance of a repeating task, or the single instance of a task that does not repeat.

**Waiting**:
A follow-up that has not yet been made available by its predecessor.
