# Existing Task owner workflow runtime

This adapter joins the finite Workflow application to the same Task profile
journal, lifecycle owners and published control facades used by ordinary tasks.
It owns no provider, Task owner, scheduler, timer, second journal, account,
credential store or admission-epoch producer.

`NewTasks` accepts trusted `Routes` composition. `Original` selects the original
operation's retained read route; `Selected` selects the already approved current
mutation/observation route on that same Task owner. `Resolve` reads the existing
selected host/model authority. Missing routes remain unavailable. Only a
classified `TASK_NOT_FOUND` from the actual operation query proves absence.
Mutations delegate to `CancelExact`, `DeliverExact`, `ContinueExact` and
`ResumeExact`; they never replace the atomic Task dispatch/reference guards.

`New` takes the existing concrete `task.Filesystem`, these Tasks, a composer,
the actual initiating-parent recheck and a trusted global capacity. `Activate`
explicitly retains the exact immutable content-free plan before one finite
scheduling round. `Reconnect` reconstructs that plan for observation only;
construction, storage reads and restart restore no live admission. `Cancel` and
`Deliver` use the original stored task/operation/parent identities. These methods
perform no background scheduling or automatic provider/parent retry.

Plans and pre-callback consumption are stored in an optional extension of the
existing atomic Task image. Ordinary Task `Admit` enforces the same global count.
A reservation with no original Task operation remains occupied and unknown;
restart, missing children, cancellation requested, revoke, closed parents and
lost acknowledgements cannot release it. Original known terminal or rejected
Task receipts provide release evidence. Existing reservations never permit
another callback. Parent authority is rechecked before reservation and after its
publication waits, and Task still rechecks the original actual grant before its
provider boundary. No parent callback runs while the Task journal mutex is held.

The optional extension preserves byte-identical canonical v1 images when absent.
Old binaries reject enriched images: downgrade/upgrade and native persistence
acceptance must remain explicit. There is no migration, pruning, recovery,
lock stealing or format fallback. Reaching fixed bounds refuses further work.

Workflow follow-up activation is intentionally not exposed by this runtime:
initial-plan callback reservations cannot grant a new follow-up operation.
The low-level Tasks adapter supports existing exact owner methods for a future
explicit original-plan follow-up seam. Production Codex cancellation remains
unsupported unless the actual selected host supports it; no controlled test
capability is promoted to shipping evidence.

Co-located composed tests use the actual Task filesystem/lease, `Owner`,
`NewOwned`, published facade and Workflow runtime on disposable state. Authority,
provider and parent IO are controlled. Linux tests do not prove Darwin locking,
selected native host/schema, installed UI, provider credentials, live effects or
whole-product activation. Root owns shipping selection/composition and must
supply the original initiating Chat authority and physical owner boundaries.
