import type { OrderRecord } from "../domain/types";

export type OrderUpdateName =
  | "risk_approved"
  | "risk_blocked"
  | "submitted"
  | "new"
  | "partially_filled"
  | "filled"
  | "cancel_requested"
  | "replace_requested"
  | "replaced"
  | "rejected"
  | "canceled";

const allowedTransitions: Record<OrderRecord["status"], OrderRecord["status"][]> = {
  planned: ["risk_approved", "risk_blocked"],
  risk_approved: ["submitted"],
  risk_blocked: [],
  submitted: ["new", "rejected", "filled", "partially_filled"],
  new: ["partially_filled", "filled", "cancel_requested", "replace_requested", "rejected", "canceled"],
  partially_filled: ["filled", "cancel_requested", "replace_requested", "canceled"],
  cancel_requested: ["canceled", "filled", "partially_filled"],
  replace_requested: ["replaced", "rejected", "filled", "partially_filled", "new"],
  replaced: ["new", "partially_filled", "filled", "cancel_requested", "replace_requested", "canceled", "rejected"],
  rejected: [],
  canceled: ["filled"],
  filled: [],
};

export function transitionOrder(order: OrderRecord, nextStatus: OrderUpdateName, at: string): OrderRecord {
  if (order.status === nextStatus) {
    return { ...order, updated_at_utc: at };
  }
  if (!allowedTransitions[order.status].includes(nextStatus)) {
    throw new Error(`Invalid order transition ${order.status} -> ${nextStatus} for ${order.client_order_id}`);
  }
  return {
    ...order,
    status: nextStatus,
    updated_at_utc: at,
    replace_count: nextStatus === "replace_requested" ? order.replace_count + 1 : order.replace_count,
  };
}
