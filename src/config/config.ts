import { readFileSync } from "node:fs";
import { sha256 } from "../util/hash";
import type { TradingMode } from "../domain/types";

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
    min_underlying_momentum_bps: number;
    require_vwap_alignment: boolean;
  };
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
    max_loss_per_trade_dollars: number;
    max_daily_loss_dollars: number;
    max_trades_per_day: number;
    max_open_positions: number;
    max_open_orders: number;
    max_position_notional_dollars: number;
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
    time_stop_minutes: number;
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
    start_streams_at_et: "09:20:00",
    first_entry_time_et: "09:35:00",
    last_entry_time_et: "15:15:00",
    force_flatten_time_et: "15:45:00",
    cancel_open_orders_time_et: "15:50:00",
  },
  universe: {
    dte_min: 0,
    dte_max: 7,
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
    min_underlying_momentum_bps: 5,
    require_vwap_alignment: true,
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
    max_loss_per_trade_dollars: 100,
    max_daily_loss_dollars: 300,
    max_trades_per_day: 5,
    max_open_positions: 1,
    max_open_orders: 1,
    max_position_notional_dollars: 500,
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
    take_profit_pct: 0.25,
    stop_loss_pct: 0.15,
    time_stop_minutes: 20,
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

function normalizeConfig(config: AppConfig): void {
  config.watchlist.underlyings = config.watchlist.underlyings.map((symbol) => symbol.toUpperCase());
  if (config.execution.order_type !== "limit" || config.execution.time_in_force !== "day") {
    throw new Error("v1 only supports limit DAY option orders.");
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== "object" || typeof patch !== "object") {
    return patch ?? base;
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
