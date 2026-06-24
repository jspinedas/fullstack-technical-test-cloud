'use strict';

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const logger = require('../utils/logger');

// Initialized at module level so Lambda container reuse avoids repeated SDK client setup.
const client = new SESClient({ region: process.env.AWS_REGION });

async function sendReportEmail({ to, reportType, requestId }) {
  logger.info('Sending report email', { to, reportType, requestId });

  const command = new SendEmailCommand({
    Source: process.env.SOURCE_EMAIL,
    // Included only when set: SES rejects the call if ConfigurationSetName is undefined.
    ...(process.env.CONFIGURATION_SET && { ConfigurationSetName: process.env.CONFIGURATION_SET }),
    Destination: {
      ToAddresses: [to],
    },
    Message: {
      Subject: {
        Data: `Your ${reportType} report is ready`,
        Charset: 'UTF-8',
      },
      Body: {
        Text: {
          Data: buildEmailBody(reportType, requestId),
          Charset: 'UTF-8',
        },
      },
    },
  });

  try {
    const response = await client.send(command);
    logger.info('Email sent', { to, reportType, requestId, messageId: response.MessageId });
    return response;
  } catch (error) {
    logger.error('Failed to send email', { to, reportType, requestId, error });
    // Re-throw so Lambda marks the invocation as failed, triggering SQS retry → DLQ.
    throw error;
  }
}

function buildEmailBody(reportType, requestId) {
  return [
    `Your ${reportType} report has been processed successfully.`,
    '',
    `Request ID: ${requestId}`,
  ].join('\n');
}

module.exports = { sendReportEmail };
