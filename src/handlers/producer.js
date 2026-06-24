'use strict';

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { validateReportPayload } = require('../utils/validation');
const logger = require('../utils/logger');

// Initialized at module level: Lambda container reuse avoids repeated client setup.
const client = new SQSClient({ region: process.env.AWS_REGION });

async function handler(event) {
  const requestId = event.requestContext?.requestId ?? 'unknown';

  logger.info('Report request received', { requestId });

  const body = parseBody(event);
  if (!body) {
    logger.warn('Invalid JSON body', { requestId });
    return respond(400, { message: 'Request body must be valid JSON' });
  }

  const validation = validateReportPayload(body);
  if (!validation.valid) {
    logger.warn('Validation failed', { requestId, errors: validation.errors });
    return respond(400, { message: 'Validation failed', errors: validation.errors });
  }

  try {
    const command = new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify({
        email: body.email,
        reportType: body.reportType,
        requestId,
      }),
    });

    const result = await client.send(command);

    logger.info('Message published to SQS', {
      requestId,
      sqsMessageId: result.MessageId,
      email: body.email,
    });

    return respond(202, { message: 'Report request accepted', requestId });
  } catch (error) {
    logger.error('Failed to publish to SQS', { requestId, error });
    return respond(500, { message: 'Internal server error' });
  }
}

function parseBody(event) {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
      : event.body ?? '';
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

module.exports = { handler };
