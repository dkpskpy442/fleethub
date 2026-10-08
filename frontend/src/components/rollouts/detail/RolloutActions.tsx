import { Ban, CheckCircle2, Pause, Play, RotateCcw, Send, ThumbsDown } from "lucide-react";
import type { RolloutDetail } from "../../../lib/types";
import { ActionButton, useMe } from "../../domain";

/** Only the actions valid for the rollout's current status; permission gating is done by ActionButton. */
export function RolloutActions({ r }: { r: RolloutDetail }) {
  const { data: me } = useMe();
  const base = `/rollouts/${r.id}`;
  const targets = r.waves.flatMap((w) => w.targets);
  const failed = targets.filter((t) => t.status === "failed").length;
  const inflight = targets.filter((t) => ["applying", "verifying", "rolling_back"].includes(t.status)).length;
  const unack = targets.filter((t) => t.status === "pending" && t.unacknowledged.length > 0).length;
  const isRequester = me?.user.id === r.requested_by.id;
  const prodWaves = r.waves.filter((w) => w.is_prod).length;
  const s = r.status;
  const approvalOpen = r.approval_status === "pending" && ["ready", "in_progress", "paused"].includes(s);

  const resumeBlocker = failed
    ? `${failed} failed target(s) must be retried, rolled back or manually verified first`
    : unack ? `${unack} target(s) have new guardrail warnings that need acknowledgement` : undefined;
  const cancelBlocker = s === "paused" && (inflight || failed)
    ? inflight ? "Targets are still in flight; wait for them or roll back" : "Resolve failed targets before cancelling"
    : undefined;

  return (
    <>
      {s === "draft" && (
        <ActionButton
          label="Submit" icon={<Send className="size-3.5" />} variant="primary" size="md" perm="rollout.submit" field="comment" requireReason={false}
          path={`${base}/submit`} success="Rollout submitted" reasonLabel="Comment (optional)" title="Submit rollout for execution"
          description={<>Re-checks every guardrail, locks the {targets.length} target deployment(s) against other rollouts{prodWaves ? <> and requests approval for {prodWaves} prod wave(s) from a release approver other than you</> : null}.</>}
        />
      )}
      {approvalOpen && (
        <>
          <ActionButton
            label="Approve prod waves" icon={<CheckCircle2 className="size-3.5" />} variant="primary" size="md" perm="rollout.approve" field="comment"
            requireReason={false} path={`${base}/approve`} success="Rollout approved" reasonLabel="Comment (optional)"
            disabled={isRequester} disabledReason="Requesters cannot approve their own rollout"
            description={<>Approving lets the {prodWaves} prod wave(s) start once earlier waves have passed their gates. Requested by {r.requested_by.name}.</>}
          />
          <ActionButton
            label="Reject" icon={<ThumbsDown className="size-3.5" />} variant="danger" size="md" perm="rollout.approve" field="comment"
            path={`${base}/reject`} success="Rollout rejected" reasonLabel="Why are you rejecting? (required)"
            disabled={isRequester} disabledReason="Requesters cannot approve or reject their own rollout"
            description={s === "ready" ? "Rejecting before start cancels the rollout." : "The rollout will pause; prod waves will not start. It can then be rolled back or cancelled."}
          />
        </>
      )}
      {s === "ready" && (
        <ActionButton
          label="Start" icon={<Play className="size-3.5" />} variant="primary" size="md" perm="rollout.execute" field="comment" requireReason={false}
          path={`${base}/start`} success="Rollout started" reasonLabel="Comment (optional)" title="Start rollout"
          description={r.approval_status === "pending"
            ? "Prod approval is still pending: non-prod waves will run now; prod waves will wait in “awaiting approval”."
            : "Wave 1 starts immediately. Each target must be confirmed by inventory and stay healthy for the bake window."}
        />
      )}
      {s === "in_progress" && (
        <ActionButton
          label="Pause" icon={<Pause className="size-3.5" />} variant="warning" size="md" perm="rollout.execute" field="comment"
          path={`${base}/pause`} success="Rollout paused" title="Pause rollout"
          description="No new targets will be applied. Targets already in flight continue to be verified."
        />
      )}
      {s === "paused" && (
        <ActionButton
          label="Resume" icon={<Play className="size-3.5" />} variant="primary" size="md" perm="rollout.execute" field="comment" requireReason={false}
          path={`${base}/resume`} success="Rollout resumed" reasonLabel="Comment (optional)" title="Resume rollout"
          disabled={!!resumeBlocker} disabledReason={resumeBlocker}
        />
      )}
      {["in_progress", "paused", "completed"].includes(s) && (
        <ActionButton
          label="Roll back" icon={<RotateCcw className="size-3.5" />} variant="danger" size="md" perm="rollout.execute" field="comment"
          path={`${base}/rollback`} success="Rollback started" title="Roll back entire rollout" reasonLabel="Reason (required)"
          description={<>Reverts every applied target to its pre-rollout revision in <b>reverse wave order</b>. Pending targets are skipped. Each rollback is confirmed against inventory just like a forward change.</>}
        />
      )}
      {["draft", "ready", "paused"].includes(s) && (
        <ActionButton
          label="Cancel" icon={<Ban className="size-3.5" />} variant="secondary" size="md" field="comment"
          perm={s === "draft" ? "rollout.create" : "rollout.execute"}
          path={`${base}/cancel`} success="Rollout cancelled" title="Cancel rollout" reasonLabel="Reason (required)"
          disabled={!!cancelBlocker} disabledReason={cancelBlocker}
          description="Pending targets are skipped and every deployment lock is released. Already-applied targets are NOT reverted — use Roll back for that."
        />
      )}
    </>
  );
}
