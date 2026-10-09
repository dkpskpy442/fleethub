import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAction } from "../lib/api";
import { Button, Modal } from "./ui";

/** Reset the shared demo world to its initial scenario. Available to every persona. */
export function ResetDemoButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const reset = useAction("POST", {
    success: "Demo data reset to the starting scenario",
    onSuccess: () => {
      setOpen(false);
      navigate("/");
      qc.invalidateQueries();
    },
  });
  return (
    <>
      {compact ? (
        <button
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          title="Reset the demo data to the starting scenario"
          onClick={() => setOpen(true)}
          data-testid="reset-demo"
        >
          <RotateCcw className="size-3" /> Reset
        </button>
      ) : (
        <Button variant="danger" onClick={() => setOpen(true)}>
          <RotateCcw className="size-4" /> Reset demo data
        </Button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Reset demo data?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate({ path: "/sim/reset" })}>
              Reset
            </Button>
          </>
        }
      >
        <p className="text-slate-600">
          Restores the synthetic fleet, catalog, findings and rollouts to the starting scenario and sets the
          simulated clock back to its start. Any rollouts, approvals and audit entries created since are discarded.
        </p>
        <p className="text-slate-600">The demo world is shared, so this affects everyone using this environment.</p>
      </Modal>
    </>
  );
}
