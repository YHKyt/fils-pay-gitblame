/**
 * apps/reporting's own configuration, loaded once from environment
 * variables at boot — same loadConfig-throws-at-boot posture as
 * apps/api's, but only the fields this worker
 * actually needs. This worker never serves HTTP, so it has no port,
 * session, or auth-related config at all.
 */
export interface ReportingConfig {
  databaseUrl: string;
  pgPoolMax: number;
  /** How often the consumer's poll-fallback timer runs a pass, independent
   *  of LISTEN/NOTIFY. Default 15_000ms — longer than webhooks' 5_000ms
   *  default, deliberately: a missed analytics notification only ever
   *  means a dashboard number is a few extra seconds later to update. */
  reportingPollIntervalMs: number;
  /** Max outbox rows read per runConsumerPass call — matches webhooks'
   *  Step A cap. */
  consumerBatchLimit: number;
}

/**
 * A positive whole number, or the fallback when unset. Anything else fails
 * loudly at boot. Number.parseInt does not: it read "15s" as 15 (a 15 ms
 * poll) and "1e3" as 1, and a batch limit of 0 made every pass select
 * nothing, so reporting stopped without an error.
 */
function parsePositiveIntEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`loadConfig: ${name} must be a positive whole number, got "${value}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReportingConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("loadConfig: DATABASE_URL environment variable is not set");
  }

  return {
    databaseUrl,
    // FH: PG_POOL_MAX is the same name apps/api reads -- setting it in compose changes both. intended?
    pgPoolMax: parsePositiveIntEnv("PG_POOL_MAX", env.PG_POOL_MAX, 5),
    // MK: 15s fine. dashboards aren't realtime.
    reportingPollIntervalMs: parsePositiveIntEnv("REPORTING_POLL_INTERVAL_MS", env.REPORTING_POLL_INTERVAL_MS, 15_000),
    consumerBatchLimit: parsePositiveIntEnv("REPORTING_CONSUMER_BATCH_LIMIT", env.REPORTING_CONSUMER_BATCH_LIMIT, 500),
  };
}
