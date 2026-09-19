import { z } from "zod";

// who is (or should be) in control of the live session
export const ControlStateSchema = z.enum([
  "AUTOMATION_RUNNING",
  "PAUSED_AWAITING_HUMAN",
  "HUMAN_IN_CONTROL",
  "RESUMING",
  "ABORTED",
]);
export type ControlState = z.infer<typeof ControlStateSchema>;

// The events that can drive a control-state transition. Kept as a closed
// union (rather than a bare `string`) so a typo'd event name is caught at
// compile time instead of only at runtime via the thrown Error below.
export type ControlEvent =
  | "escalate"
  | "operator_attach"
  | "resume"
  | "resnapshot_ok"
  | "abort";

export const SessionControl = z.object({
  runId: z.string(),
  state: ControlStateSchema,
  owner: z.enum(["automation", "human", "none"]),
  since: z.string().datetime(),
  reason: z.string().optional(),
  cdpEndpoint: z.string().optional(), // ws:// so the operator CLI can attach
});
export type SessionControl = z.infer<typeof SessionControl>;

// Legal transitions, expressed as a lookup table so the full legal-transition
// set is visible as data (and can be iterated over in tests) rather than
// scattered across if/else branches.
//
//   AUTOMATION_RUNNING    --escalate-->        PAUSED_AWAITING_HUMAN
//   PAUSED_AWAITING_HUMAN --operator_attach--> HUMAN_IN_CONTROL
//   HUMAN_IN_CONTROL      --resume-->          RESUMING
//   RESUMING              --resnapshot_ok-->   AUTOMATION_RUNNING
//   any (except ABORTED)  --abort-->           ABORTED
//
// ABORTED is a terminal dead end: it has no legal outgoing transitions,
// including "abort" from "ABORTED" itself.
const TRANSITIONS: Record<ControlState, Partial<Record<ControlEvent, ControlState>>> = {
  AUTOMATION_RUNNING: {
    escalate: "PAUSED_AWAITING_HUMAN",
    abort: "ABORTED",
  },
  PAUSED_AWAITING_HUMAN: {
    operator_attach: "HUMAN_IN_CONTROL",
    abort: "ABORTED",
  },
  HUMAN_IN_CONTROL: {
    resume: "RESUMING",
    abort: "ABORTED",
  },
  RESUMING: {
    resnapshot_ok: "AUTOMATION_RUNNING",
    abort: "ABORTED",
  },
  ABORTED: {},
};

export function transition(from: ControlState, event: ControlEvent): ControlState {
  const to = TRANSITIONS[from]?.[event];
  if (to === undefined) {
    throw new Error(`Illegal transition: cannot "${event}" from state "${from}"`);
  }
  return to;
}
