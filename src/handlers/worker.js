'use strict';

const { validateReportPayload } = require('../utils/validation');
const { sendReportEmail } = require('../services/emailService');
const logger = require('../utils/logger');

// Configurable via env var so tests can set PROCESSING_DELAY_MS=0 to skip the wait.
const PROCESSING_DELAY_MS = parseInt(process.env.PROCESSING_DELAY_MS ?? '2000', 10);

async function handler(event) {
  const failures = [];

  for (const record of event.Records) {
    const { messageId } = record;
    try {
      await processRecord(record);
    } catch (error) {
      logger.error('Message processing failed', { messageId, error });
      // Collect the failure; do NOT throw. Throwing here would mark the entire
      // batch as failed, re-queueing messages that already succeeded.
      failures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function processRecord(record) {
  const { messageId, body: rawBody } = record;

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Non-parseable body will never succeed on retry; throw so SQS eventually
    // moves it to DLQ for forensic inspection rather than silently discarding it.
    throw new Error(`Non-parseable message body — messageId: ${messageId}`);
  }

  const validation = validateReportPayload(payload);
  if (!validation.valid) {
    // Invalid structure cannot be fixed by retrying — send to DLQ via the same path.
    throw new Error(
      `Invalid payload in message ${messageId}: ${validation.errors.join(', ')}`
    );
  }

  const { email, reportType, requestId } = payload;

  logger.info('Processing report', { messageId, email, reportType, requestId });

  await simulateProcessing(reportType);

  logger.info('Report generation complete', { messageId, email, reportType, requestId });

  await sendReportEmail({ to: email, reportType, requestId });
}

function simulateProcessing(reportType) {
  logger.debug('Simulating report generation', { reportType, delayMs: PROCESSING_DELAY_MS });
  return new Promise(resolve => setTimeout(resolve, PROCESSING_DELAY_MS));
}

module.exports = { handler, processRecord };
