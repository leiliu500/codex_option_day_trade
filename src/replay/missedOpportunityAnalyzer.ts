import type { EventEnvelope } from "../domain/types";

export type MissedOpportunityBlocker =
  | "entry_window_blocked"
  | "opening_range_too_wide"
  | "score_too_low"
  | "slope_too_low"
  | "acceleration_too_low"
  | "cooldown_blocked"
  | "contract_not_found"
  | "spread_too_wide"
  | "strategy_score_too_low"
  | "strategy_policy_blocked"
  | "spread_construction_failed"
  | "risk_gate_blocked";

export interface OpportunityLabel {
  timestamp: string;
  regime: string;
  setupType: string;
  direction: "BULLISH" | "BEARISH";
  candidateScore: number;
  approved: boolean;
  wouldHaveWon: boolean;
  mfePct: number;
  maePct: number;
  timeToMfeSeconds: number;
  timeToStopSeconds?: number;
  firstBlocker?: string;
  allBlockers: MissedOpportunityBlocker[];
  rawBlockers: string[];
  selectedContract?: string;
  priceSource: "option_mid" | "underlying";
}

export interface OpportunityBucketSummary {
  regime: string;
  setupType: string;
  candidate_count: number;
  approved_count: number;
  missed_winning_count: number;
  false_positive_count: number;
  win_rate_by_score_bucket: Record<string, number>;
  average_mfe_pct: number;
  average_mae_pct: number;
  average_time_to_mfe_seconds: number;
  most_common_blocker?: string;
}

export interface OpportunityVerificationSummary {
  labels: OpportunityLabel[];
  by_regime_setup: OpportunityBucketSummary[];
}

export function analyzeMissedOpportunities(params: {
  inputEvents: EventEnvelope[];
  outputEvents: EventEnvelope[];
}): OpportunityVerificationSummary {
  const optionMids = buildOptionMidSeries(params.inputEvents);
  const underlyingPrices = buildUnderlyingSeries(params.inputEvents);
  const labels: OpportunityLabel[] = [];

  for (const event of params.outputEvents) {
    if (!event.event_type.startsWith("decision_")) {
      continue;
    }
    const candidate = event.normalized.candidate as Record<string, unknown> | undefined;
    if (!candidate) {
      continue;
    }
    const direction = String(candidate.direction);
    if (direction !== "BULLISH" && direction !== "BEARISH") {
      continue;
    }
    const selectedContract = selectedContractFromDecision(event);
    const targetPct = Math.max(0.0001, numberOrDefault(candidate.targetBps, 0) / 10_000);
    const stopPct = Math.max(0.0001, numberOrDefault(candidate.stopBps, 0) / 10_000);
    const horizonSeconds = Math.max(60, numberOrDefault(candidate.maxHoldSeconds, 1800));
    const label =
      selectedContract && optionMids.get(selectedContract)?.length
        ? labelFromOptionSeries({
            event,
            candidate,
            direction,
            selectedContract,
            series: optionMids.get(selectedContract) ?? [],
            targetPct,
            stopPct,
            horizonSeconds,
          })
        : labelFromUnderlyingSeries({
            event,
            candidate,
            direction,
            series: underlyingPrices.get(String(candidate.underlying ?? "")) ?? [],
            targetPct,
            stopPct,
            horizonSeconds,
          });
    labels.push(label);
  }

  return {
    labels,
    by_regime_setup: summarize(labels),
  };
}

function labelFromOptionSeries(params: {
  event: EventEnvelope;
  candidate: Record<string, unknown>;
  direction: "BULLISH" | "BEARISH";
  selectedContract: string;
  series: PricePoint[];
  targetPct: number;
  stopPct: number;
  horizonSeconds: number;
}): OpportunityLabel {
  const entryTime = Date.parse(params.event.received_at_utc);
  const entryPrice =
    numberOrUndefined((params.event.normalized.action as Record<string, unknown> | undefined)?.limit_price) ??
    firstPriceAtOrAfter(params.series, entryTime) ??
    latestPriceAtOrBefore(params.series, entryTime) ??
    numberOrDefault(params.candidate.triggerPrice, 0);
  const future = futurePrices(params.series, entryTime, params.horizonSeconds);
  let maxFavorable = 0;
  let maxAdverse = 0;
  let timeToMfeSeconds = 0;
  let targetAt: number | undefined;
  let stopAt: number | undefined;
  for (const point of future) {
    const movePct = entryPrice > 0 ? (point.price - entryPrice) / entryPrice : 0;
    if (movePct > maxFavorable) {
      maxFavorable = movePct;
      timeToMfeSeconds = Math.max(0, Math.round((Date.parse(point.at) - entryTime) / 1000));
    }
    if (movePct < maxAdverse) {
      maxAdverse = movePct;
    }
    targetAt ??= movePct >= params.targetPct ? Date.parse(point.at) : undefined;
    stopAt ??= movePct <= -params.stopPct ? Date.parse(point.at) : undefined;
  }
  return baseLabel(params.event, params.candidate, params.direction, {
    wouldHaveWon: targetAt !== undefined && (stopAt === undefined || targetAt <= stopAt),
    mfePct: roundPct(maxFavorable),
    maePct: roundPct(maxAdverse),
    timeToMfeSeconds,
    timeToStopSeconds: stopAt === undefined ? undefined : Math.max(0, Math.round((stopAt - entryTime) / 1000)),
    selectedContract: params.selectedContract,
    priceSource: "option_mid",
  });
}

function labelFromUnderlyingSeries(params: {
  event: EventEnvelope;
  candidate: Record<string, unknown>;
  direction: "BULLISH" | "BEARISH";
  series: PricePoint[];
  targetPct: number;
  stopPct: number;
  horizonSeconds: number;
}): OpportunityLabel {
  const entryTime = Date.parse(params.event.received_at_utc);
  const entryPrice =
    numberOrUndefined(params.candidate.triggerPrice) ??
    firstPriceAtOrAfter(params.series, entryTime) ??
    latestPriceAtOrBefore(params.series, entryTime) ??
    0;
  const future = futurePrices(params.series, entryTime, params.horizonSeconds);
  let maxFavorable = 0;
  let maxAdverse = 0;
  let timeToMfeSeconds = 0;
  let targetAt: number | undefined;
  let stopAt: number | undefined;
  for (const point of future) {
    const rawMovePct = entryPrice > 0 ? (point.price - entryPrice) / entryPrice : 0;
    const movePct = params.direction === "BULLISH" ? rawMovePct : -rawMovePct;
    if (movePct > maxFavorable) {
      maxFavorable = movePct;
      timeToMfeSeconds = Math.max(0, Math.round((Date.parse(point.at) - entryTime) / 1000));
    }
    if (movePct < maxAdverse) {
      maxAdverse = movePct;
    }
    targetAt ??= movePct >= params.targetPct ? Date.parse(point.at) : undefined;
    stopAt ??= movePct <= -params.stopPct ? Date.parse(point.at) : undefined;
  }
  return baseLabel(params.event, params.candidate, params.direction, {
    wouldHaveWon: targetAt !== undefined && (stopAt === undefined || targetAt <= stopAt),
    mfePct: roundPct(maxFavorable),
    maePct: roundPct(maxAdverse),
    timeToMfeSeconds,
    timeToStopSeconds: stopAt === undefined ? undefined : Math.max(0, Math.round((stopAt - entryTime) / 1000)),
    priceSource: "underlying",
  });
}

function baseLabel(
  event: EventEnvelope,
  candidate: Record<string, unknown>,
  direction: "BULLISH" | "BEARISH",
  result: {
    wouldHaveWon: boolean;
    mfePct: number;
    maePct: number;
    timeToMfeSeconds: number;
    timeToStopSeconds?: number;
    selectedContract?: string;
    priceSource: "option_mid" | "underlying";
  },
): OpportunityLabel {
  const rawBlockers = rawDecisionBlockers(event);
  const blockers = canonicalDecisionBlockers(event, rawBlockers);
  return {
    timestamp: event.received_at_utc,
    regime: String(candidate.regime ?? "UNKNOWN"),
    setupType: String(candidate.setupType ?? "UNKNOWN"),
    direction,
    candidateScore: numberOrDefault(candidate.score, 0),
    approved: event.event_type === "decision_approved",
    wouldHaveWon: result.wouldHaveWon,
    mfePct: result.mfePct,
    maePct: result.maePct,
    timeToMfeSeconds: result.timeToMfeSeconds,
    ...(result.timeToStopSeconds === undefined ? {} : { timeToStopSeconds: result.timeToStopSeconds }),
    ...(blockers[0] === undefined ? {} : { firstBlocker: blockers[0] }),
    allBlockers: blockers,
    rawBlockers,
    ...(result.selectedContract === undefined ? {} : { selectedContract: result.selectedContract }),
    priceSource: result.priceSource,
  };
}

function summarize(labels: OpportunityLabel[]): OpportunityBucketSummary[] {
  const groups = new Map<string, OpportunityLabel[]>();
  for (const label of labels) {
    const key = `${label.regime}|${label.setupType}`;
    const current = groups.get(key) ?? [];
    current.push(label);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [regime, setupType] = key.split("|");
      return {
        regime,
        setupType,
        candidate_count: group.length,
        approved_count: group.filter((label) => label.approved).length,
        missed_winning_count: group.filter((label) => !label.approved && label.wouldHaveWon).length,
        false_positive_count: group.filter((label) => label.approved && !label.wouldHaveWon).length,
        win_rate_by_score_bucket: scoreBuckets(group),
        average_mfe_pct: roundPct(average(group.map((label) => label.mfePct))),
        average_mae_pct: roundPct(average(group.map((label) => label.maePct))),
        average_time_to_mfe_seconds: Math.round(average(group.map((label) => label.timeToMfeSeconds))),
        most_common_blocker: mostCommon(group.flatMap((label) => label.allBlockers)),
      };
    })
    .sort((a, b) => b.candidate_count - a.candidate_count || a.regime.localeCompare(b.regime));
}

function scoreBuckets(labels: OpportunityLabel[]): Record<string, number> {
  const buckets = new Map<string, { wins: number; total: number }>();
  for (const label of labels) {
    const floor = Math.floor(label.candidateScore / 10) * 10;
    const key = `${floor}-${floor + 9}`;
    const bucket = buckets.get(key) ?? { wins: 0, total: 0 };
    bucket.total += 1;
    if (label.wouldHaveWon) {
      bucket.wins += 1;
    }
    buckets.set(key, bucket);
  }
  return Object.fromEntries(
    [...buckets.entries()]
      .sort((a, b) => Number(a[0].split("-")[0]) - Number(b[0].split("-")[0]))
      .map(([key, bucket]) => [key, roundPct(bucket.wins / bucket.total)]),
  );
}

function rawDecisionBlockers(event: EventEnvelope): string[] {
  const normalized = event.normalized;
  const riskDecision = normalized.risk_decision as Record<string, unknown> | undefined;
  const candidate = normalized.candidate as Record<string, unknown> | undefined;
  const strategyDecision = normalized.strategy_decision as Record<string, unknown> | undefined;
  const blockedReasons = Array.isArray(normalized.blocked_reasons)
    ? normalized.blocked_reasons.map(String)
    : Array.isArray(riskDecision?.blocked_reasons)
      ? riskDecision.blocked_reasons.map(String)
      : [];
  const candidateBlockers = Array.isArray(candidate?.blockers) ? candidate.blockers.map(String) : [];
  const strategyNoTrade = typeof strategyDecision?.noTradeReason === "string" ? [strategyDecision.noTradeReason] : [];
  const strategyCandidateBlockers = Array.isArray(strategyDecision?.candidates)
    ? (strategyDecision.candidates as Array<Record<string, unknown>>).flatMap((strategyCandidate) =>
        Array.isArray(strategyCandidate.blockers) ? strategyCandidate.blockers.map(String) : [],
      )
    : [];
  const reasonCodes = Array.isArray(normalized.reason_codes)
    ? normalized.reason_codes.map(String)
    : Array.isArray((normalized.signal as Record<string, unknown> | undefined)?.reason_codes)
      ? ((normalized.signal as Record<string, unknown>).reason_codes as unknown[]).map(String)
      : [];
  const semanticReasons = reasonCodes.filter((reason) =>
    reason.includes("blocked") ||
    reason.includes("not_fresh") ||
    reason.includes("waiting_for_confirmation") ||
    reason.includes("no_contract") ||
    reason.includes("outside_entry_window") ||
    reason.includes("score_too_low") ||
    reason.includes("slope_too_low") ||
    reason.includes("acceleration_too_low") ||
    reason.includes("stale") ||
    reason.includes("too_wide") ||
    reason.includes("too_high") ||
    reason.includes("too_small") ||
    reason.includes("strategy") ||
    reason.includes("spread") ||
    reason.includes("credit") ||
    reason.includes("debit") ||
    reason.includes("iron_condor") ||
    reason.includes("no_edge"),
  );
  return [...new Set([...blockedReasons, ...candidateBlockers, ...strategyNoTrade, ...strategyCandidateBlockers, ...semanticReasons])];
}

function canonicalDecisionBlockers(event: EventEnvelope, rawBlockers: string[]): MissedOpportunityBlocker[] {
  const output: MissedOpportunityBlocker[] = [];
  const add = (reason: MissedOpportunityBlocker): void => {
    if (!output.includes(reason)) {
      output.push(reason);
    }
  };
  for (const reason of rawBlockers) {
    const normalized = reason.toLowerCase();
    if (normalized === "outside_entry_window") {
      add("entry_window_blocked");
    }
    if (normalized === "opening_range_too_wide") {
      add("opening_range_too_wide");
    }
    if (normalized === "score_too_low") {
      add("score_too_low");
    }
    if (normalized === "slope_too_low") {
      add("slope_too_low");
    }
    if (normalized === "acceleration_too_low") {
      add("acceleration_too_low");
    }
    if (normalized === "entry_setup_not_fresh") {
      add("cooldown_blocked");
    }
    if (normalized === "no_contract_candidate" || normalized === "contract_not_found") {
      add("contract_not_found");
    }
    if (normalized === "spread_too_wide") {
      add("spread_too_wide");
    }
    if (normalized === "strategy_score_too_low") {
      add("strategy_score_too_low");
    }
    if (
      normalized === "no_valid_strategy_candidate" ||
      normalized === "credit_spreads_disabled" ||
      normalized === "debit_spreads_disabled" ||
      normalized === "iron_condor_disabled" ||
      normalized === "long_straddles_disabled" ||
      normalized === "strategy_disabled"
    ) {
      add("strategy_policy_blocked");
    }
    if (
      normalized === "spread_contract_not_found" ||
      normalized === "spread_quote_invalid" ||
      normalized === "spread_debit_too_high" ||
      normalized === "spread_width_too_wide" ||
      normalized === "credit_too_small"
    ) {
      add("spread_construction_failed");
    }
  }
  const riskDecision = event.normalized.risk_decision as Record<string, unknown> | undefined;
  const riskBlocked = event.event_type === "decision_blocked" || riskDecision?.approved === false;
  if (riskBlocked) {
    add("risk_gate_blocked");
  }
  return output;
}

function selectedContractFromDecision(event: EventEnvelope): string | undefined {
  const direct = event.normalized.selected_contract;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const action = event.normalized.action as Record<string, unknown> | undefined;
  const legs = Array.isArray(action?.legs) ? (action.legs as Array<Record<string, unknown>>) : [];
  const symbol = legs[0]?.symbol;
  return typeof symbol === "string" && symbol.length > 0 ? symbol : undefined;
}

interface PricePoint {
  at: string;
  price: number;
}

function buildOptionMidSeries(events: EventEnvelope[]): Map<string, PricePoint[]> {
  const series = new Map<string, PricePoint[]>();
  for (const event of events) {
    if (event.event_type !== "option_quote" && event.event_type !== "option_snapshot") {
      continue;
    }
    const symbol = String(event.normalized.symbol ?? event.symbol ?? "");
    const bid = numberOrUndefined(event.normalized.bid);
    const ask = numberOrUndefined(event.normalized.ask);
    if (!symbol || bid === undefined || ask === undefined || ask <= bid) {
      continue;
    }
    const current = series.get(symbol) ?? [];
    current.push({ at: event.received_at_utc, price: (bid + ask) / 2 });
    series.set(symbol, current);
  }
  for (const values of series.values()) {
    values.sort((a, b) => a.at.localeCompare(b.at));
  }
  return series;
}

function buildUnderlyingSeries(events: EventEnvelope[]): Map<string, PricePoint[]> {
  const series = new Map<string, PricePoint[]>();
  for (const event of events) {
    if (event.event_type !== "underlying_quote" && event.event_type !== "underlying_bar") {
      continue;
    }
    const symbol = String(event.normalized.symbol ?? event.symbol ?? "");
    const price = numberOrUndefined(event.normalized.close ?? event.normalized.last_price ?? event.normalized.price);
    if (!symbol || price === undefined) {
      continue;
    }
    const current = series.get(symbol) ?? [];
    current.push({ at: event.received_at_utc, price });
    series.set(symbol, current);
  }
  for (const values of series.values()) {
    values.sort((a, b) => a.at.localeCompare(b.at));
  }
  return series;
}

function futurePrices(series: PricePoint[], entryTime: number, horizonSeconds: number): PricePoint[] {
  const horizon = entryTime + horizonSeconds * 1000;
  return series.filter((point) => {
    const at = Date.parse(point.at);
    return at >= entryTime && at <= horizon;
  });
}

function firstPriceAtOrAfter(series: PricePoint[], atMs: number): number | undefined {
  return series.find((point) => Date.parse(point.at) >= atMs)?.price;
}

function latestPriceAtOrBefore(series: PricePoint[], atMs: number): number | undefined {
  let latest: number | undefined;
  for (const point of series) {
    if (Date.parse(point.at) > atMs) {
      break;
    }
    latest = point.price;
  }
  return latest;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundPct(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
