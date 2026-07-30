import type { Config } from "./config.js";
import { discordRuntimeStatus } from "./discord.js";

export function sanitizedRuntimeConfig(
  config: Config,
  exactOriginCount: number,
): {
  discord: ReturnType<typeof discordRuntimeStatus>;
  providers: {
    fingerprintConfigured: boolean;
    proxycheckConfigured: boolean;
    abstractIpConfigured: boolean;
    abstractEmailConfigured: boolean;
    opportifyConfigured: boolean;
  };
  live: {
    redisConfigured: boolean;
    readTokenConfigured: boolean;
    adminTokenConfigured: boolean;
    exactOriginsConfigured: boolean;
  };
  ingest: {
    endpointConfigured: boolean;
    secretConfigured: boolean;
  };
  externalWebappMonitor: {
    endpointConfigured: boolean;
    independentAlertSinkConfigured: boolean;
  };
  fiatEligibility: {
    devCredentialConfigured: boolean;
    prodCredentialConfigured: boolean;
    devSourceConfigured: boolean;
    devIpAllowlistConfigured: boolean;
    prodIpAllowlistConfigured: boolean;
  };
} {
  return {
    discord: discordRuntimeStatus(config),
    providers: {
      fingerprintConfigured: Boolean(config.FINGERPRINT_SECRET_API_KEY),
      proxycheckConfigured: Boolean(config.PROXYCHECK_API_KEY),
      abstractIpConfigured: Boolean(
        config.ABSTRACT_IP_INTELLIGENCE_API_KEY,
      ),
      abstractEmailConfigured: Boolean(
        config.ABSTRACT_EMAIL_REPUTATION_API_KEY,
      ),
      opportifyConfigured: Boolean(config.OPPORTIFY_API_KEY),
    },
    live: {
      redisConfigured: Boolean(config.REDIS_URL),
      readTokenConfigured: Boolean(config.API_TOKEN),
      adminTokenConfigured: Boolean(config.API_ADMIN_TOKEN),
      exactOriginsConfigured: exactOriginCount > 0,
    },
    ingest: {
      endpointConfigured: Boolean(config.ANTIFRAUD_INGEST_URL),
      secretConfigured: Boolean(config.ANTIFRAUD_INGEST_SECRET),
    },
    externalWebappMonitor: {
      endpointConfigured: Boolean(config.ANTIFRAUD_WEBAPP_HEALTH_URL),
      independentAlertSinkConfigured: Boolean(
        config.DISCORD_WEBAPP_ERRORS_WEBHOOK_URL,
      ),
    },
    fiatEligibility: {
      devCredentialConfigured: Boolean(
        config.FIAT_ELIGIBILITY_DEV_API_KEY,
      ),
      prodCredentialConfigured: Boolean(
        config.FIAT_ELIGIBILITY_PROD_API_KEY,
      ),
      devSourceConfigured: Boolean(
        config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL,
      ),
      devIpAllowlistConfigured: Boolean(
        config.FIAT_ELIGIBILITY_DEV_ALLOWED_IPS.trim(),
      ),
      prodIpAllowlistConfigured: Boolean(
        config.FIAT_ELIGIBILITY_PROD_ALLOWED_IPS.trim(),
      ),
    },
  };
}
