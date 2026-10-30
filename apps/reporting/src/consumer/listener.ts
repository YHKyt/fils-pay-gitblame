import { Client, type Pool } from "pg";
import type { ReportingConfig } from "../config.js";
import { runConsumerPass } from "./runConsumerPass.js";

/**
 * Must match the channel the outbox trigger notifies on (db/migrations);
 * a NOTIFY on any other channel is silently ignored.
 */
const NOTIFY_CHANNEL = "outbox_events_channel";

export interface ReportingConsumerHandle {
  stop(): Promise<void>;
}

/**
 * Starts the reporting consumer: a dedicated LISTEN connection on the
 * webhook dispatcher's existing trigger/channel for near-real-time reaction
 * to fresh outbox_events inserts, plus a poll-interval safety net that
 * guarantees no event is stuck forever even if a NOTIFY is missed —
 * identical shape to apps/api/src/webhooks/dispatcher.ts's
 * `startWebhookDispatcher`.
 */
export function startReportingConsumer(pool: Pool, config: ReportingConfig): ReportingConsumerHandle {
  let running = false;
  let stopped = false;

  // Set when more work may be waiting once the running pass ends: a NOTIFY
  // or tick arrived mid-pass (its events may be past that pass's snapshot),
  // or the pass applied a full batch. Without it a backlog drained one
  // batch per poll interval (500 events / 15 s) instead of back to back.
  let rerun = false;

  const triggerPass = (): void => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    rerun = false;
    runConsumerPass(pool, config)
      .then(({ processedCount }) => {
        if (processedCount >= config.consumerBatchLimit) rerun = true;
      })
      .catch((err: unknown) => {
        // A thrown error from one pass must never crash the listener or the
        // process — the next NOTIFY or poll tick simply tries again.
        console.error("[reporting/consumer] consumer pass failed", err);
      })
      .finally(() => {
        running = false;
        if (rerun) triggerPass();
      });
  };

  // MK: dedicated Client, not from the pool -- LISTEN needs a pinned connection. DO NOT TOUCH
  // incident 2026-05-14 (missed settlement close): root cause was this client silently losing LISTEN after a pg restart. -- FH
  // am: but the poll covers missed NOTIFYs... and reporting doesn't close batches?? MK: the timeline is in the incident doc. AM: which doc
  const listenClient = new Client({ connectionString: config.databaseUrl });
  let listenClientConnected = false;

  listenClient.on("error", (err: Error) => {
    console.error("[reporting/consumer] LISTEN client error", err);
  });
  // copilot: triggerPass already ignores notifications while a pass is running, so no debounce is needed.
  listenClient.on("notification", () => {
    triggerPass();
  });

  const connectPromise = listenClient
    .connect()
    .then(async () => {
      listenClientConnected = true;
      await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
      // Run one pass immediately on startup so a restart resumes and
      // catches up on any backlog without waiting for the first NOTIFY or
      // poll tick.
      triggerPass();
    })
    .catch((err: unknown) => {
      // NOTIFY is an optimization, not the sole mechanism — the poll
      // interval below still guarantees eventual processing even if the
      // LISTEN connection never comes up.
      console.error("[reporting/consumer] failed to establish LISTEN connection", err);
    });

  // am: if LISTEN dies the worker stops processing until restart
  const interval = setInterval(triggerPass, config.reportingPollIntervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      await connectPromise;
      if (listenClientConnected) {
        await listenClient.end().catch(() => {});
      }
    },
  };
}
