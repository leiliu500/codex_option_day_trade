import test from "node:test";
import assert from "node:assert/strict";
import { transitionOrder } from "../../src/engine/orderStateMachine";
import type { OrderRecord } from "../../src/domain/types";

test("order state machine allows fill after cancel request race", () => {
  const base: OrderRecord = {
    client_order_id: "cid",
    action_id: "aid",
    status: "new",
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    side: "buy",
    qty: 1,
    filled_qty: 0,
    position_intent: "buy_to_open",
    updated_at_utc: "2026-06-11T14:00:00.000Z",
    replace_count: 0,
  };
  const cancelRequested = transitionOrder(base, "cancel_requested", "2026-06-11T14:00:01.000Z");
  const filled = transitionOrder(cancelRequested, "filled", "2026-06-11T14:00:02.000Z");
  assert.equal(filled.status, "filled");
});

test("order state machine rejects impossible terminal transition", () => {
  const base: OrderRecord = {
    client_order_id: "cid",
    action_id: "aid",
    status: "filled",
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    side: "buy",
    qty: 1,
    filled_qty: 1,
    position_intent: "buy_to_open",
    updated_at_utc: "2026-06-11T14:00:00.000Z",
    replace_count: 0,
  };
  assert.throws(() => transitionOrder(base, "canceled", "2026-06-11T14:00:01.000Z"), /Invalid order transition/);
});
