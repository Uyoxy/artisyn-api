// Add these module-level variables at the top of the file,
// alongside the existing alertStore / metricsStore declarations:
let alertCleanupInterval: NodeJS.Timeout | null = null;
let errorRateInterval: NodeJS.Timeout | null = null;

// Replace the existing startMonitoringScheduler with this version:
export const startMonitoringScheduler = () => {
  alertCleanupInterval = setInterval(
    () => {
      clearOldAlerts(24);
    },
    60 * 60 * 1000,
  );

  errorRateInterval = setInterval(
    () => {
      const tooHighErrorRate = checkErrorRateThreshold(5);
      if (tooHighErrorRate) {
        const metrics = getCurrentMetrics();
        createAlert(
          "api-error",
          "high",
          `High error rate detected: ${metrics?.errorRate.toFixed(2)}%`,
          { errorRate: metrics?.errorRate },
        );
      }
    },
    5 * 60 * 1000,
  );
};

/**
 * Stop all monitoring intervals.
 * Call this during graceful shutdown.
 */
export const stopMonitoringScheduler = () => {
  if (alertCleanupInterval) {
    clearInterval(alertCleanupInterval);
    alertCleanupInterval = null;
  }
  if (errorRateInterval) {
    clearInterval(errorRateInterval);
    errorRateInterval = null;
  }
};
