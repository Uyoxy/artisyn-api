import express, { Express } from "express";
import { facebookStrategy, googleStrategy } from "./passport";
import {
  ipBlockingMiddleware,
  loadBlockedIPsFromDB,
  recordFailedAttemptMiddleware,
  startIPBlockingCleanup,
} from "src/middleware/ipBlocking";
import {
  preventParameterPollutionMiddleware,
  sanitizeHeadersMiddleware,
  securityHeadersMiddleware,
  timingAttackPreventionMiddleware,
} from "src/middleware/securityHeaders";
import {
  rateLimitMiddleware,
  registerBypassToken,
  startRateLimitCleanup,
} from "src/middleware/rateLimiter";
import {
  requestLoggingMiddleware,
  startLogCleanupScheduler,
} from "src/utils/securityLogging";
import routes, { loadRoutes } from "src/routes/index";

import { ErrorHandler } from "./request-handlers";
import { analyticsMiddleware } from "./analyticsMiddleware";
import { apiKeyValidationMiddleware } from "src/services/apiKeyService";
import cors from "cors";
import { env } from "./helpers";
import { fileURLToPath } from "url";
import logger from "pino-http";
import methodOverride from "method-override";
import passport from "passport";
import path from "path";
import { startAnalyticsScheduler } from "./analyticsScheduler";
import { startMediaScheduler } from "./mediaScheduler";
import { startMonitoringScheduler } from "src/services/monitoringService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const initialize = async (app: Express) => {
  // ===== HTTP LOGGER (must be first to wrap full request lifecycle) =====
  // pino-http must precede all other middleware so it can observe both
  // the incoming request and the final response status, even for errors.
  if (env("NODE_ENV") !== "test") {
    app.use(logger());
  }

  // ===== BODY PARSING MIDDLEWARE =====
  // Registered here only. Do not add body parsers anywhere else —
  // duplicate registration causes unpredictable request-processing
  // behavior and makes middleware ordering harder to reason about.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ===== SECURITY MIDDLEWARE =====
  // Security headers - protects against common vulnerabilities
  app.use(securityHeadersMiddleware);

  // Sanitize request headers
  app.use(sanitizeHeadersMiddleware);

  // IP blocking - blocks IPs with suspicious behavior
  app.use(ipBlockingMiddleware);

  // Prevent parameter pollution attacks
  app.use(preventParameterPollutionMiddleware);

  // Timing attack prevention for auth endpoints
  app.use(timingAttackPreventionMiddleware);

  // Rate limiting middleware - tiered by user type
  app.use(rateLimitMiddleware);

  // Initialize rate limit bypass tokens from environment
  const bypassTokensEnv = process.env.RATE_LIMIT_BYPASS_TOKENS || "";
  if (bypassTokensEnv) {
    const tokens = bypassTokensEnv.split(",").map((t) => t.trim());
    tokens.forEach((token) => {
      if (token) {
        registerBypassToken(token);
        console.log(`[Security] Registered rate limit bypass token`);
      }
    });
  }

  // API key validation
  app.use(apiKeyValidationMiddleware);

  // Request logging for security events
  app.use(requestLoggingMiddleware);

  // Record failed authentication attempts for IP blocking
  app.use(recordFailedAttemptMiddleware(["/auth/login", "/auth/register"]));

  // Method override
  app.use(methodOverride("X-HTTP-Method"));

  // ===== ROUTING AND AUTH =====
  await loadRoutes(path.resolve(__dirname, "../routes"));
  app.use(cors());

  if (env("GOOGLE_CLIENT_ID")) {
    passport.use(googleStrategy());
  }
  if (env("FACEBOOK_CLIENT_ID")) {
    passport.use(facebookStrategy());
  }

  app.use(passport.initialize());

  // Analytics Middleware - track API calls before routing
  app.use(analyticsMiddleware);

  // Routes
  app.use(routes);

  // Error Handler (after routes, before scheduler boot)
  app.use(ErrorHandler);

  // ===== BACKGROUND SERVICES =====
  if (process.env.NODE_ENV !== "test") {
    console.log("[Security] Starting security services and schedulers...");
  }

  startRateLimitCleanup();
  startIPBlockingCleanup();
  await loadBlockedIPsFromDB();
  startMonitoringScheduler();
  startLogCleanupScheduler();
  startAnalyticsScheduler();
  startMediaScheduler();

  if (process.env.NODE_ENV !== "test") {
    console.log("[Security] All security services initialized successfully");
  }
};
