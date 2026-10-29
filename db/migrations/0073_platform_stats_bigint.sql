-- platform_stats.total_processed_fils was created INTEGER (0049): a 32-bit
-- column whose maximum, 2,147,483,647 fils (~2.147M BD), sits just above the
-- 2,000,000,000-fils volume-tier threshold. Lifetime platform volume passes
-- that quickly; the settlement accumulator (int32 in Go) then wrapped negative
-- and the 0.15% volume discount switched itself back off. Every other money
-- column is BIGINT (ADR-0001 / ARCHITECTURE "Money"); make this one match.
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
