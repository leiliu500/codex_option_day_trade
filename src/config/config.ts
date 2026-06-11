import { readFileSync } from "node:fs";
import { sha256 } from "../util/hash";
import { clockMinusMinutes, clockPlusMinutes } from "../util/time";
import type { TradingMode } from "../domain/types";

export type RiskLimit = number | null;

export interface RegimeConfig {
  opening_range: {
    hard_block_bps: number;
    old_soft_limit_bps: number;
    allow_wide_directional: boolean;
  };
  entry_window: {
    normal_first_entry_delay_minutes: number;
    high_confidence_first_entry_delay_minutes: number;
    grind_first_entry_delay_minutes: number;
    last_entry_time_et: string;
  };
  slope: {
    strong_ema9_slope_bps_per_min: number;
    strong_ema21_slope_bps_per_min: number;
    grind_ema9_slope_bps_per_min: number;
    grind_ema21_slope_bps_per_min: number;
    grind_vwap_slope_bps_per_min: number;
    flat_slope_abs_bps_per_min: number;
  };
  trend_quality: {
    strong_trend_efficiency10: number;
    grind_trend_efficiency20: number;
    chop_trend_efficiency10: number;
    min_regression_r2_strong: number;
    min_regression_r2_grind: number;
  };
  chop: {
    max_flat_vwap_slope_bps_per_min: number;
    min_vwap_cross_count10: number;
    min_alternating_bar_rate10: number;
    min_doji_rate10: number;
  };
  whipsaw: {
    min_range_expansion_ratio: number;
    min_vwap_cross_count10: number;
    max_trend_efficiency10: number;
    require_confirmation_bars: number;
    size_multiplier: number;
  };
  gap: {
    min_gap_bps: number;
    max_gap_fill_pct_for_gap_and_go: number;
    min_relative_volume: number;
  };
  grind: {
    min_short_momentum_bps: number;
    max_pullback_depth_bps: number;
    min_higher_low_count: number;
    min_lower_high_count: number;
    target_pct: number;
    stop_pct: number;
    max_hold_seconds: number;
    normal_vol_ceiling_bps: number;
    micro_range_bps: number;
  };
  strong: {
    min_short_momentum_bps: number;
    target_pct: number;
    stop_pct: number;
    max_hold_seconds: number;
  };
  reversal: {
    min_score: number;
    require_retest: boolean;
    target_pct: number;
    stop_pct: number;
    max_hold_seconds: number;
  };
  candidate_scores: {
    min_strong_score: number;
    min_grind_score: number;
    min_gap_and_go_score: number;
    min_reversal_score: number;
    min_chop_breakout_score: number;
    min_whipsaw_reversal_score: number;
    min_wide_directional_score: number;
  };
  repeat_entry: {
    default_cooldown_sec: number;
    strong_trend_cooldown_sec: number;
    grind_cooldown_sec: number;
    reversal_cooldown_sec: number;
    same_setup_cooldown_sec: number;
    different_setup_cooldown_sec: number;
    min_new_move_bps_default: number;
    min_new_move_bps_grind: number;
    require_new_pullback_for_grind: boolean;
    max_entries_per_direction_per_day: number;
    max_entries_per_regime_per_day: number;
  };
  contract_selection: {
    max_spread_pct: number;
    min_bid: number;
    min_mid: number;
    max_mid: number;
    min_open_interest: number;
    max_quote_age_seconds: number;
    require_option_mid_confirmation: boolean;
    delta_by_regime: Record<string, [number, number]>;
  };
}

export interface AppConfig {
  system: {
    name: string;
    environment: TradingMode;
    timezone: string;
    store_timestamps_as_utc: boolean;
  };
  alpaca: {
    paper: boolean;
    option_feed: string;
    stock_feed: string;
    rest_timeout_seconds: number;
    rest_max_retries: number;
    rest_retry_backoff_seconds: number;
  };
  watchlist: {
    underlyings: string[];
  };
  session: {
    regular_open_et: string;
    regular_close_et: string;
    entry_start_buffer_minutes: number;
    start_streams_at_et: string;
    first_entry_time_et: string;
    last_entry_time_et: string;
    force_flatten_time_et: string;
    cancel_open_orders_time_et: string;
  };
  universe: {
    dte_min: number;
    dte_max: number;
    strike_window_pct: number;
    max_contracts_per_underlying: number;
    refresh_interval_seconds: number;
    include_calls: boolean;
    include_puts: boolean;
  };
  snapshot: {
    refresh_interval_seconds: number;
    max_snapshot_age_seconds: number;
  };
  stream: {
    max_quote_age_seconds: number;
    reconnect_backoff_seconds: number;
    max_reconnect_backoff_seconds: number;
    no_new_entries_on_disconnect: boolean;
    max_required_stream_lag_seconds: number;
  };
  strategy: {
    enabled: boolean;
    name: string;
    opening_range_minutes: number;
    max_opening_range_bps: number | null;
    min_underlying_momentum_bps: number;
    min_breakout_bps: number;
    min_vwap_distance_bps: number;
    entry_cooldown_seconds: number;
    min_new_move_bps: number;
    entry_confirmation_seconds: number;
    require_vwap_alignment: boolean;
  };
  regime: RegimeConfig;
  contract_selector: {
    target_abs_delta: number;
    min_abs_delta: number;
    max_abs_delta: number;
    max_spread_pct_of_mid: number;
    min_bid: number;
    min_mid: number;
    max_mid: number;
    min_open_interest: number;
    prefer_near_the_money: boolean;
  };
  risk: {
    max_loss_per_trade_dollars: RiskLimit;
    max_daily_loss_dollars: RiskLimit;
    max_trades_per_day: RiskLimit;
    max_open_positions: RiskLimit;
    max_open_orders: RiskLimit;
    max_position_notional_dollars: RiskLimit;
    block_new_entries_after_daily_loss: boolean;
    block_new_entries_after_rejects: number;
    block_if_broker_reconciliation_mismatch: boolean;
  };
  execution: {
    order_type: "limit";
    time_in_force: "day";
    limit_entry_style: "mid";
    buy_price_improvement_ticks: number;
    max_replace_count: number;
    replace_after_seconds: number;
    cancel_if_signal_invalidates: boolean;
    client_order_id_prefix: string;
  };
  exit: {
    take_profit_pct: number;
    stop_loss_pct: number;
    breakeven_trigger_pct: number;
    trailing_stop_activation_pct: number;
    trailing_stop_pct: number;
    time_stop_minutes: number;
    defer_loss_exits_while_underlying_trend_valid: boolean;
    exit_on_signal_reversal: boolean;
    force_flatten_before_close: boolean;
  };
  replay: {
    fill_model: "optimistic_mid" | "conservative_bid_ask" | "next_quote_cross" | "no_fill";
    require_deterministic_decisions: boolean;
    report_dir: string;
  };
}

export interface RuntimeSecrets {
  alpacaApiKey?: string;
  alpacaSecretKey?: string;
  alpacaBaseUrl: string;
  alpacaDataUrl: string;
}

export const defaultConfig: AppConfig = {
  system: {
    name: "live-option-day-trader",
    environment: "paper",
    timezone: "America/New_York",
    store_timestamps_as_utc: true,
  },
  alpaca: {
    paper: true,
    option_feed: "opra",
    stock_feed: "sip",
    rest_timeout_seconds: 10,
    rest_max_retries: 3,
    rest_retry_backoff_seconds: 1,
  },
  watchlist: {
    underlyings: ["SPY"],
  },
  session: {
    regular_open_et: "09:30:00",
    regular_close_et: "16:00:00",
    entry_start_buffer_minutes: 30,
    start_streams_at_et: "09:20:00",
    first_entry_time_et: "10:00:00",
    last_entry_time_et: "15:30:00",
    force_flatten_time_et: "15:30:00",
    cancel_open_orders_time_et: "15:50:00",
  },
  universe: {
    dte_min: 0,
    dte_max: 0,
    strike_window_pct: 0.04,
    max_contracts_per_underlying: 100,
    refresh_interval_seconds: 300,
    include_calls: true,
    include_puts: true,
  },
  snapshot: {
    refresh_interval_seconds: 60,
    max_snapshot_age_seconds: 120,
  },
  stream: {
    max_quote_age_seconds: 2,
    reconnect_backoff_seconds: 2,
    max_reconnect_backoff_seconds: 60,
    no_new_entries_on_disconnect: true,
    max_required_stream_lag_seconds: 10,
  },
  strategy: {
    enabled: true,
    name: "orb_vwap_long_options",
    opening_range_minutes: 5,
    max_opening_range_bps: 25,
    min_underlying_momentum_bps: 15,
    min_breakout_bps: 6,
    min_vwap_distance_bps: 5,
    entry_cooldown_seconds: 600,
    min_new_move_bps: 25,
    entry_confirmation_seconds: 0,
    require_vwap_alignment: true,
  },
  regime: {
    opening_range: {
      hard_block_bps: 60,
      old_soft_limit_bps: 25,
      allow_wide_directional: true,
    },
    entry_window: {
      normal_first_entry_delay_minutes: 30,
      high_confidence_first_entry_delay_minutes: 15,
      grind_first_entry_delay_minutes: 30,
      last_entry_time_et: "15:30:00",
    },
    slope: {
      strong_ema9_slope_bps_per_min: 2.5,
      strong_ema21_slope_bps_per_min: 1,
      grind_ema9_slope_bps_per_min: 0.5,
      grind_ema21_slope_bps_per_min: 0.35,
      grind_vwap_slope_bps_per_min: 0.25,
      flat_slope_abs_bps_per_min: 0.2,
    },
    trend_quality: {
      strong_trend_efficiency10: 0.55,
      grind_trend_efficiency20: 0.45,
      chop_trend_efficiency10: 0.3,
      min_regression_r2_strong: 0.45,
      min_regression_r2_grind: 0.35,
    },
    chop: {
      max_flat_vwap_slope_bps_per_min: 0.2,
      min_vwap_cross_count10: 3,
      min_alternating_bar_rate10: 0.5,
      min_doji_rate10: 0.4,
    },
    whipsaw: {
      min_range_expansion_ratio: 1.8,
      min_vwap_cross_count10: 3,
      max_trend_efficiency10: 0.4,
      require_confirmation_bars: 2,
      size_multiplier: 0.5,
    },
    gap: {
      min_gap_bps: 30,
      max_gap_fill_pct_for_gap_and_go: 0.3,
      min_relative_volume: 1.2,
    },
    grind: {
      min_short_momentum_bps: 3,
      max_pullback_depth_bps: 18,
      min_higher_low_count: 2,
      min_lower_high_count: 2,
      target_pct: 0.15,
      stop_pct: 0.1,
      max_hold_seconds: 1800,
      normal_vol_ceiling_bps: 18,
      micro_range_bps: 12,
    },
    strong: {
      min_short_momentum_bps: 8,
      target_pct: 0.25,
      stop_pct: 0.12,
      max_hold_seconds: 1200,
    },
    reversal: {
      min_score: 76,
      require_retest: true,
      target_pct: 0.22,
      stop_pct: 0.12,
      max_hold_seconds: 1500,
    },
    candidate_scores: {
      min_strong_score: 72,
      min_grind_score: 68,
      min_gap_and_go_score: 78,
      min_reversal_score: 76,
      min_chop_breakout_score: 85,
      min_whipsaw_reversal_score: 88,
      min_wide_directional_score: 78,
    },
    repeat_entry: {
      default_cooldown_sec: 600,
      strong_trend_cooldown_sec: 300,
      grind_cooldown_sec: 420,
      reversal_cooldown_sec: 900,
      same_setup_cooldown_sec: 600,
      different_setup_cooldown_sec: 300,
      min_new_move_bps_default: 25,
      min_new_move_bps_grind: 8,
      require_new_pullback_for_grind: true,
      max_entries_per_direction_per_day: 3,
      max_entries_per_regime_per_day: 2,
    },
    contract_selection: {
      max_spread_pct: 0.15,
      min_bid: 0.05,
      min_mid: 0.2,
      max_mid: 10,
      min_open_interest: 100,
      max_quote_age_seconds: 2,
      require_option_mid_confirmation: true,
      delta_by_regime: {
        STRONG_UP_CALL: [0.45, 0.65],
        STRONG_DOWN_PUT: [-0.65, -0.45],
        GRIND_UP_CALL: [0.55, 0.75],
        GRIND_DOWN_PUT: [-0.75, -0.55],
        REVERSAL_UP_CALL: [0.5, 0.7],
        REVERSAL_DOWN_PUT: [-0.7, -0.5],
        GAP_AND_GO_UP_CALL: [0.45, 0.7],
        GAP_AND_GO_DOWN_PUT: [-0.7, -0.45],
        WIDE_DIRECTIONAL_UP_CALL: [0.5, 0.7],
        WIDE_DIRECTIONAL_DOWN_PUT: [-0.7, -0.5],
        HIGH_VOL_WHIPSAW_CALL: [0.55, 0.75],
        HIGH_VOL_WHIPSAW_PUT: [-0.75, -0.55],
      },
    },
  },
  contract_selector: {
    target_abs_delta: 0.5,
    min_abs_delta: 0.35,
    max_abs_delta: 0.65,
    max_spread_pct_of_mid: 0.15,
    min_bid: 0.05,
    min_mid: 0.2,
    max_mid: 10,
    min_open_interest: 100,
    prefer_near_the_money: true,
  },
  risk: {
    max_loss_per_trade_dollars: null,
    max_daily_loss_dollars: null,
    max_trades_per_day: null,
    max_open_positions: null,
    max_open_orders: null,
    max_position_notional_dollars: null,
    block_new_entries_after_daily_loss: true,
    block_new_entries_after_rejects: 2,
    block_if_broker_reconciliation_mismatch: true,
  },
  execution: {
    order_type: "limit",
    time_in_force: "day",
    limit_entry_style: "mid",
    buy_price_improvement_ticks: 0,
    max_replace_count: 3,
    replace_after_seconds: 2,
    cancel_if_signal_invalidates: true,
    client_order_id_prefix: "lotd",
  },
  exit: {
    take_profit_pct: 0.6,
    stop_loss_pct: 0.12,
    breakeven_trigger_pct: 0.12,
    trailing_stop_activation_pct: 0.2,
    trailing_stop_pct: 0.1,
    time_stop_minutes: 10,
    defer_loss_exits_while_underlying_trend_valid: true,
    exit_on_signal_reversal: true,
    force_flatten_before_close: true,
  },
  replay: {
    fill_model: "conservative_bid_ask",
    require_deterministic_decisions: true,
    report_dir: "reports/replay",
  },
};

export function loadConfig(configPath?: string): { config: AppConfig; configHash: string } {
  const loaded = configPath ? parseYamlSubset(readFileSync(configPath, "utf8")) : {};
  const config = deepMerge(defaultConfig, loaded) as AppConfig;
  normalizeConfig(config);
  return { config, configHash: sha256(config) };
}

export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeSecrets {
  return {
    alpacaApiKey: env.ALPACA_API_KEY,
    alpacaSecretKey: env.ALPACA_SECRET_KEY,
    alpacaBaseUrl: env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets",
    alpacaDataUrl: env.ALPACA_DATA_URL ?? "https://data.alpaca.markets",
  };
}

export function assertSafeTradingMode(
  config: AppConfig,
  flags: { paper?: boolean; live?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): TradingMode {
  const requested: TradingMode = flags.live ? "live" : "paper";
  if (flags.paper && flags.live) {
    throw new Error("Choose exactly one mode: --paper or --live.");
  }
  if (requested === "live") {
    const enabled = env.ENABLE_LIVE_TRADING === "true";
    if (!enabled || !flags.live || config.system.environment !== "live" || config.alpaca.paper) {
      throw new Error(
        "Live trading refused. Requires ENABLE_LIVE_TRADING=true, --live, system.environment=live, and alpaca.paper=false.",
      );
    }
    return "live";
  }
  config.system.environment = "paper";
  config.alpaca.paper = true;
  return "paper";
}

export function isRiskLimitEnabled(limit: RiskLimit): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

function normalizeConfig(config: AppConfig): void {
  config.watchlist.underlyings = config.watchlist.underlyings.map((symbol) => symbol.toUpperCase());
  config.universe.dte_min = 0;
  config.universe.dte_max = 0;
  config.session.entry_start_buffer_minutes = Math.max(30, Math.floor(config.session.entry_start_buffer_minutes));
  config.session.first_entry_time_et = clockPlusMinutes(config.session.regular_open_et, config.session.entry_start_buffer_minutes);
  config.session.last_entry_time_et = clockMinusMinutes(config.session.regular_close_et, 30);
  config.session.force_flatten_time_et = clockMinusMinutes(config.session.regular_close_et, 30);
  if (config.execution.order_type !== "limit" || config.execution.time_in_force !== "day") {
    throw new Error("v1 only supports limit DAY option orders.");
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    base === null ||
    patch === null ||
    Array.isArray(base) ||
    Array.isArray(patch) ||
    typeof base !== "object" ||
    typeof patch !== "object"
  ) {
    return patch === undefined ? base : patch;
  }
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function parseYamlSubset(text: string): Record<string, unknown> {
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines
    .map((line, index) => ({ line: stripComment(line), index }))
    .filter(({ line }) => line.trim().length > 0);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }];

  for (let i = 0; i < lines.length; i += 1) {
    const { line, index } = lines[i];
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;
    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`YAML line ${index + 1}: list item has no list parent.`);
      }
      parent.push(parseScalar(trimmed.slice(2).trim()));
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 1) {
      throw new Error(`YAML line ${index + 1}: expected key/value pair.`);
    }
    if (Array.isArray(parent)) {
      throw new Error(`YAML line ${index + 1}: nested list maps are not supported by this loader.`);
    }
    const key = trimmed.slice(0, colon).trim();
    const valueText = trimmed.slice(colon + 1).trim();
    if (valueText.length > 0) {
      parent[key] = parseScalar(valueText);
      continue;
    }
    const next = lines.slice(i + 1).find(({ line: maybe }) => maybe.trim().length > 0);
    const nextTrimmed = next?.line.trim();
    const container: Record<string, unknown> | unknown[] = nextTrimmed?.startsWith("- ") ? [] : {};
    parent[key] = container;
    stack.push({ indent, value: container });
  }
  return root;
}

function stripComment(line: string): string {
  let quoted = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === "'" || char === '"') && (i === 0 || line[i - 1] !== "\\")) {
      quoted = quoted && quote === char ? false : !quoted;
      quote = quoted ? char : "";
    }
    if (char === "#" && !quoted) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseScalar(value: string): unknown {
  const unquoted = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (unquoted === "true") {
    return true;
  }
  if (unquoted === "false") {
    return false;
  }
  if (unquoted === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }
  return unquoted;
}
