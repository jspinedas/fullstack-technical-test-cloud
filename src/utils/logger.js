'use strict';

function log(level, message, metadata = {}) {
  const { error, ...rest } = metadata;

  const entry = {
    level,
    timestamp: new Date().toISOString(),
    environment: process.env.ENVIRONMENT || 'local',
    message,
    ...rest,
  };

  if (error instanceof Error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } else if (error !== undefined) {
    entry.error = error;
  }

  console.log(JSON.stringify(entry));
}

const logger = {
  debug: (message, metadata) => log('debug', message, metadata),
  info: (message, metadata) => log('info', message, metadata),
  warn: (message, metadata) => log('warn', message, metadata),
  error: (message, metadata) => log('error', message, metadata),
};

module.exports = logger;
