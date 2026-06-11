import type { AppConfig } from "../config/config";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope, RiskDecision, Signal, SignalDirection, TradeAction } from "../domain/types";
import type { EventStore } from "../data/eventStore";
import type { ExecutionAdapter } from "../broker/protocols";
import { secondsBetweenIso } from "../util/time";
import { SignalEngine } from "./signalEngine";
import { ContractSelector } from "./contractSelector";
import { RiskEngine } from "./riskEngine";
import { ExecutionPolicy } from "./executionPolicy";
import { PositionManager } from "./positionManager";

export interface DomainEngineOptions {
  runId: string;
  configHash: string;
  config: AppConfig;
  state: LiveState;
  eventStore: EventStore;
  eventFactory: EventFactory;
  executionAdapter: ExecutionAdapter;
}

export class DomainEngine {
  private readonly signalEngine: SignalEngine;
  private readonly selector: ContractSelector;
  private readonly riskEngine: RiskEngine;
  private readonly executionPolicy: ExecutionPolicy;
  private readonly positionManager: PositionManager;
  private readonly entryGate = new Map<string, EntryGateState>();
  private readonly pendingEntryGate = new Map<string, PendingEntryGateState>();

  constructor(private readonly options: DomainEngineOptions) {
    this.signalEngine = new SignalEngine(options.config, options.runId);
    this.selector = new ContractSelector(options.config);
    this.riskEngine = new RiskEngine(options.config, options.configHash);
    this.executionPolicy = new ExecutionPolicy(options.config, options.runId);
    this.positionManager = new PositionManager(options.config, this.executionPolicy);
  }

  async handleEvent(event: EventEnvelope): Promise<void> {
    const applied = this.options.state.applyEvent(event);
    if (!applied) {
      this.options.eventStore.append(
        this.options.eventFactory.next(
          "duplicate_event_ignored",
          "replay",
          { duplicate_event_id: event.event_id, duplicate_event_type: event.event_type },
          { correlation_id: event.event_id, received_at_utc: event.received_at_utc },
        ),
      );
      return;
    }
    await this.evaluate(event.received_at_utc, event);
  }

  async evaluate(nowIso: string, triggerEvent?: EventEnvelope): Promise<void> {
    for (const exitAction of this.positionManager.evaluateExits(this.options.state, nowIso)) {
      await this.submitIfApproved(exitAction, nowIso);
    }
    if (!this.shouldEvaluateEntries(triggerEvent)) {
      return;
    }
    for (const underlying of this.options.config.watchlist.underlyings) {
      const signal = this.signalEngine.evaluateEntry(this.options.state, underlying, nowIso);
      if (signal.direction === "none") {
        this.pendingEntryGate.delete(signal.underlying_symbol);
        this.appendDecision("decision_no_trade", signal, undefined, undefined, nowIso, {
          reason_codes: signal.reason_codes,
        });
        continue;
      }
      if (!this.entrySetupIsConfirmed(signal, nowIso)) {
        this.appendDecision("decision_no_trade", signal, undefined, undefined, nowIso, {
          reason_codes: [...signal.reason_codes, "entry_setup_waiting_for_confirmation"],
        });
        continue;
      }
      if (!this.entrySetupIsFresh(signal, nowIso)) {
        this.appendDecision("decision_no_trade", signal, undefined, undefined, nowIso, {
          reason_codes: [...signal.reason_codes, "entry_setup_not_fresh"],
        });
        continue;
      }
      const candidates = this.selector.select(signal, this.options.state, nowIso);
      if (candidates.length === 0) {
        this.appendDecision("decision_no_trade", signal, undefined, undefined, nowIso, {
          reason_codes: ["no_contract_candidate"],
        });
        continue;
      }
      const action = this.executionPolicy.buildOpenAction(signal, candidates[0], nowIso);
      const riskDecision = this.riskEngine.evaluate(action, this.options.state, nowIso, this.options.configHash);
      this.appendRisk(riskDecision, action, nowIso);
      if (!riskDecision.approved) {
        this.appendDecision("decision_blocked", signal, action, riskDecision, nowIso, {
          selected_contract: candidates[0].contract.symbol,
          blocked_reasons: riskDecision.blocked_reasons,
        });
        continue;
      }
      this.appendDecision("decision_approved", signal, action, riskDecision, nowIso, {
        selected_contract: candidates[0].contract.symbol,
      });
      this.markEntrySetup(signal, nowIso);
      await this.submitOrder(action, nowIso);
    }
  }

  private shouldEvaluateEntries(triggerEvent: EventEnvelope | undefined): boolean {
    return !triggerEvent || triggerEvent.event_type === "underlying_quote" || triggerEvent.event_type === "underlying_bar";
  }

  private entrySetupIsConfirmed(signal: Signal, nowIso: string): boolean {
    if (this.options.config.strategy.entry_confirmation_seconds <= 0) {
      return true;
    }
    const price = numberOrUndefined(signal.features.price);
    if (price === undefined || (signal.direction !== "bullish" && signal.direction !== "bearish")) {
      return false;
    }
    const pending = this.pendingEntryGate.get(signal.underlying_symbol);
    if (!pending || pending.direction !== signal.direction) {
      this.pendingEntryGate.set(signal.underlying_symbol, {
        direction: signal.direction,
        first_seen_at_utc: nowIso,
      });
      return false;
    }
    return secondsBetweenIso(pending.first_seen_at_utc, nowIso) >= this.options.config.strategy.entry_confirmation_seconds;
  }

  private entrySetupIsFresh(signal: Signal, nowIso: string): boolean {
    const price = numberOrUndefined(signal.features.price);
    if (price === undefined) {
      return false;
    }
    const gate = this.entryGate.get(signal.underlying_symbol);
    if (!gate || gate.direction !== signal.direction) {
      return true;
    }
    if (secondsBetweenIso(gate.entered_at_utc, nowIso) < this.options.config.strategy.entry_cooldown_seconds) {
      return false;
    }
    const moveBps =
      signal.direction === "bullish"
        ? ((price - gate.entry_price) / gate.entry_price) * 10_000
        : ((gate.entry_price - price) / gate.entry_price) * 10_000;
    return moveBps >= this.options.config.strategy.min_new_move_bps;
  }

  private markEntrySetup(signal: Signal, nowIso: string): void {
    const price = numberOrUndefined(signal.features.price);
    if (price === undefined || (signal.direction !== "bullish" && signal.direction !== "bearish")) {
      return;
    }
    this.entryGate.set(signal.underlying_symbol, {
      direction: signal.direction,
      entry_price: price,
      entered_at_utc: nowIso,
    });
    this.pendingEntryGate.delete(signal.underlying_symbol);
  }

  private async submitIfApproved(action: TradeAction, nowIso: string): Promise<void> {
    const riskDecision = this.riskEngine.evaluate(action, this.options.state, nowIso, this.options.configHash);
    this.appendRisk(riskDecision, action, nowIso);
    if (!riskDecision.approved) {
      this.options.eventStore.append(
        this.options.eventFactory.next(
          "position_exit_blocked",
          "position_manager",
          { action, risk_decision: riskDecision },
          { symbol: action.legs[0]?.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
        ),
      );
      return;
    }
    await this.submitOrder(action, nowIso);
  }

  private async submitOrder(action: TradeAction, nowIso: string): Promise<void> {
    const submitted = this.options.eventFactory.next(
      "order_submitted",
      "execution",
      { action },
      { symbol: action.legs[0]?.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
    );
    this.options.eventStore.append(submitted);
    this.options.state.applyEvent(submitted);
    try {
      const brokerEvents = await this.options.executionAdapter.submitOrder(
        action,
        this.options.state,
        nowIso,
        this.options.eventFactory,
      );
      for (const brokerEvent of brokerEvents) {
        this.options.eventStore.append(brokerEvent);
        this.options.state.applyEvent(brokerEvent);
      }
    } catch (error) {
      const rejected = this.options.eventFactory.next(
        "trade_update",
        "execution",
        {
          client_order_id: action.client_order_id,
          action_id: action.action_id,
          status: "rejected",
          symbol: action.legs[0]?.symbol,
          underlying_symbol: action.underlying_symbol,
          side: action.legs[0]?.side,
          qty: action.qty,
          limit_price: action.limit_price,
          position_intent: action.legs[0]?.position_intent,
          error: (error as Error).message,
        },
        { symbol: action.legs[0]?.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
      );
      this.options.eventStore.append(rejected);
      this.options.state.applyEvent(rejected);
    }
  }

  private appendRisk(riskDecision: RiskDecision, action: TradeAction, nowIso: string): void {
    this.options.eventStore.append(
      this.options.eventFactory.next(
        "risk_decision",
        "risk",
        { risk_decision: riskDecision, action },
        { symbol: action.legs[0]?.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
      ),
    );
  }

  private appendDecision(
    eventType: string,
    signal: Signal,
    action: TradeAction | undefined,
    riskDecision: RiskDecision | undefined,
    nowIso: string,
    extra: Record<string, unknown>,
  ): void {
    this.options.eventStore.append(
      this.options.eventFactory.next(
        eventType,
        "strategy",
        {
          signal,
          action,
          risk_decision: riskDecision,
          ...extra,
        },
        { symbol: signal.underlying_symbol, correlation_id: action?.action_id ?? signal.signal_id, received_at_utc: nowIso },
      ),
    );
  }
}

interface EntryGateState {
  direction: Extract<SignalDirection, "bullish" | "bearish">;
  entry_price: number;
  entered_at_utc: string;
}

interface PendingEntryGateState {
  direction: Extract<SignalDirection, "bullish" | "bearish">;
  first_seen_at_utc: string;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
