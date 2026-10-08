import { useState } from "react";
import { useAction } from "../../lib/api";
import { fmtTime, useNow } from "../../lib/format";
import type { FindingStatus, FindingView } from "../../lib/types";
import { useCan } from "../domain";
import { Button, Field, Input, Modal, Select, Textarea } from "../ui";

const STATUSES: { value: FindingStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "risk_accepted", label: "Risk accepted (time-boxed)" },
  { value: "false_positive", label: "False positive" },
  { value: "remediated", label: "Remediated" },
];

const toDateInput = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
/** A date input is interpreted as end of that day (UTC) in simulated time. */
const fromDateInput = (s: string) => (s ? Math.floor(Date.parse(`${s}T23:59:59Z`) / 1000) : null);

export function TriageButton({ finding, label }: { finding: FindingView; label: string }) {
  const allowed = useCan("finding.triage");
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const [notes, setNotes] = useState("");
  const [until, setUntil] = useState("");
  const act = useAction("POST", { success: "Finding triaged", onSuccess: () => setOpen(false) });

  const openDialog = () => {
    setStatus(finding.status);
    setNotes(finding.notes ?? "");
    setUntil(toDateInput(finding.accepted_until ?? now + 14 * 86400));
    setOpen(true);
  };

  const acceptedUntil = status === "risk_accepted" ? fromDateInput(until) : null;
  const untilError = status === "risk_accepted" && (!acceptedUntil || acceptedUntil <= now) ? "Expiry must be after the current simulated time." : null;
  const notesError = status === "risk_accepted" && !notes.trim() ? "Risk acceptance requires a justification." : null;

  return (
    <>
      <Button size="sm" disabled={!allowed} title={allowed ? undefined : "Your role lacks permission: finding.triage"} onClick={openDialog}>Triage</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Triage finding · ${label}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={act.isPending}
              disabled={!!untilError || !!notesError}
              onClick={() => act.mutate({ path: `/findings/${finding.id}/triage`, body: { status, notes, accepted_until: acceptedUntil } })}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus)} options={STATUSES} />
        </Field>
        {status === "risk_accepted" && (
          <Field
            label="Accepted until"
            hint={<>Simulated now: {fmtTime(now)}. Must be later; on expiry the finding re-opens automatically.{untilError && <span className="block text-red-600">{untilError}</span>}</>}
          >
            <Input type="date" value={until} min={toDateInput(now)} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        )}
        <Field label={status === "risk_accepted" ? "Justification" : "Notes"} hint="Recorded in the audit log.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {notesError && <div className="text-xs text-red-600">{notesError}</div>}
      </Modal>
    </>
  );
}
