#!/usr/bin/env node
import { createUsageMeter } from './usage-meter.js';

const SNAPSHOT_PROTOCOL = 'cti-model-usage-snapshot/v1';

function unavailable(error: string): Record<string, unknown> {
  return {
    protocol: SNAPSHOT_PROTOCOL,
    generatedAt: new Date().toISOString(),
    status: 'unavailable',
    error: error.slice(0, 96),
    records: [],
    summary: null,
    window: {
      maxRetainedRecords: 0,
      retainedRecords: 0,
      displayLimit: 200,
      recordsTruncated: false,
      oldestTimestamp: null,
      newestTimestamp: null,
      dateTimeZone: 'UTC',
    },
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(): void {
  const args = process.argv.slice(2).filter((item) => item !== '--json');
  if (args[0] !== 'snapshot' || args.length > 1) {
    print(unavailable('usage_invalid_command'));
    process.exitCode = 2;
    return;
  }
  try {
    print(createUsageMeter().snapshot());
  } catch {
    // Keep the panel boundary deterministic and never expose filesystem or
    // provider details from a CLI failure.
    print(unavailable('usage_unavailable'));
  }
}

main();
