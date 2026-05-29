'use strict';

/**
 * PM2 Ecosystem Config — Production deployment.
 *
 * Start:   pm2 start ecosystem.config.js --env production
 * Monitor: pm2 monit
 * Logs:    pm2 logs slipr-api
 * Reload:  pm2 reload slipr-api   (zero-downtime)
 *
 * cluster mode spawns one process per CPU core automatically.
 * All processes share the same Redis rate-limit store and MongoDB pool.
 */

module.exports = {
  apps: [
    {
      name: 'slipr-api',
      script: './server.js',

      // Spawn one worker per CPU core (e.g. 8 on a c5.2xlarge)
      instances: 'max',
      exec_mode: 'cluster',

      // Restart if memory climbs above 512 MB (memory leak guard)
      max_memory_restart: '512M',

      // Auto-restart on crash with exponential back-off
      autorestart: true,
      restart_delay: 1000,
      max_restarts: 10,

      // Wait for the server to be fully ready before routing traffic
      wait_ready: true,
      listen_timeout: 15000,  // 15 s
      kill_timeout: 5000,     // 5 s for graceful shutdown

      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },

      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },

      // Log rotation (requires pm2-logrotate module: pm2 install pm2-logrotate)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file:   './logs/pm2-out.log',
      merge_logs: true,
    },
  ],
};
