import { getClient, getDeviceId } from './cloudSync';

export type UserTier = 'free' | 'core' | 'pro' | 'team' | 'enterprise';

interface TierLimits {
  maxDailyInterventions:    number;
  voiceEnabled:             boolean;
  calendarEnabled:          boolean;
  emailEnabled:             boolean;
  screenAwarenessEnabled:   boolean;
  subAgentsEnabled:         boolean;
  softLockEnabled:          boolean;
  phoneMonitoringEnabled:   boolean;
  maxDevices:               number;
  priorityRouting:          boolean;
  appMonitoringEnabled:     boolean;
  driftDetectionEnabled:    boolean;
  basicInterventionsEnabled: boolean;
}

const TIER_LIMITS: Record<UserTier, TierLimits> = {
  free: {
    maxDailyInterventions:    3,
    voiceEnabled:             false,
    calendarEnabled:          false,
    emailEnabled:             false,
    screenAwarenessEnabled:   false,
    subAgentsEnabled:         false,
    softLockEnabled:          false,
    phoneMonitoringEnabled:   false,
    maxDevices:               1,
    priorityRouting:          false,
    appMonitoringEnabled:     true,
    driftDetectionEnabled:    true,
    basicInterventionsEnabled: true,
  },
  core: {
    maxDailyInterventions:    999,
    voiceEnabled:             true,
    calendarEnabled:          true,
    emailEnabled:             true,
    screenAwarenessEnabled:   false,
    subAgentsEnabled:         false,
    softLockEnabled:          false,
    phoneMonitoringEnabled:   false,
    maxDevices:               1,
    priorityRouting:          false,
    appMonitoringEnabled:     true,
    driftDetectionEnabled:    true,
    basicInterventionsEnabled: true,
  },
  pro: {
    maxDailyInterventions:    999,
    voiceEnabled:             true,
    calendarEnabled:          true,
    emailEnabled:             true,
    screenAwarenessEnabled:   true,
    subAgentsEnabled:         true,
    softLockEnabled:          true,
    phoneMonitoringEnabled:   true,
    maxDevices:               3,
    priorityRouting:          true,
    appMonitoringEnabled:     true,
    driftDetectionEnabled:    true,
    basicInterventionsEnabled: true,
  },
  team: {
    maxDailyInterventions:    999,
    voiceEnabled:             true,
    calendarEnabled:          true,
    emailEnabled:             true,
    screenAwarenessEnabled:   true,
    subAgentsEnabled:         true,
    softLockEnabled:          true,
    phoneMonitoringEnabled:   true,
    maxDevices:               5,
    priorityRouting:          true,
    appMonitoringEnabled:     true,
    driftDetectionEnabled:    true,
    basicInterventionsEnabled: true,
  },
  enterprise: {
    maxDailyInterventions:    999,
    voiceEnabled:             true,
    calendarEnabled:          true,
    emailEnabled:             true,
    screenAwarenessEnabled:   true,
    subAgentsEnabled:         true,
    softLockEnabled:          true,
    phoneMonitoringEnabled:   true,
    maxDevices:               999,
    priorityRouting:          true,
    appMonitoringEnabled:     true,
    driftDetectionEnabled:    true,
    basicInterventionsEnabled: true,
  },
};

let currentTier: UserTier        = 'free';
let dailyInterventionCount       = 0;
let lastResetDate                = '';

export async function initTierService(): Promise<void> {
  const envTier = process.env.AXON_USER_TIER as UserTier;
  if (envTier && TIER_LIMITS[envTier]) {
    currentTier = envTier;
    console.log(`[TierService] tier loaded from env: ${currentTier}`);
    return;
  }

  try {
    const supabase = getClient();
    if (!supabase) {
      console.log('[TierService] Supabase not configured — defaulting to free');
      currentTier = 'free';
      return;
    }
    const deviceId = getDeviceId();

    const { data } = await supabase
      .from('users')
      .select('tier, tier_expires_at')
      .eq('device_id', deviceId)
      .single();

    if (data?.tier) {
      if (data.tier_expires_at) {
        const expired = new Date(data.tier_expires_at) < new Date();
        if (expired) {
          currentTier = 'free';
          console.log('[TierService] tier expired — downgraded to free');
          return;
        }
      }
      currentTier = data.tier as UserTier;
      console.log(`[TierService] tier loaded from Supabase: ${currentTier}`);
    } else {
      currentTier = 'free';
      console.log('[TierService] no tier found — defaulting to free');
    }
  } catch (err) {
    console.error('[TierService] failed to load tier:', err);
    currentTier = 'free';
  }
}

export function getTier(): UserTier {
  return currentTier;
}

export function getLimits(): TierLimits {
  return TIER_LIMITS[currentTier];
}

export function canSpeak(): boolean {
  return getLimits().voiceEnabled;
}

export function canIntervene(): boolean {
  const today = new Date().toDateString();
  if (lastResetDate !== today) {
    dailyInterventionCount = 0;
    lastResetDate = today;
  }
  return dailyInterventionCount < getLimits().maxDailyInterventions;
}

export function recordIntervention(): void {
  dailyInterventionCount++;
  console.log(`[TierService] intervention ${dailyInterventionCount}/${getLimits().maxDailyInterventions} today`);
}

export function getRemainingInterventions(): number {
  const max = getLimits().maxDailyInterventions;
  if (max === 999) return 999;
  return Math.max(0, max - dailyInterventionCount);
}

export function isFeatureEnabled(feature: keyof TierLimits): boolean {
  return !!getLimits()[feature];
}

export function getUpgradePrompt(feature: string): string {
  const messages: Record<string, string> = {
    voice:         "Voice requires Core or above. Upgrade at aretica.ai.",
    interventions: `You've used your 3 free interventions today. Upgrade to Core for unlimited.`,
    calendar:      "Calendar integration requires Core or above. Upgrade at aretica.ai.",
    screen:        "Screen awareness requires Pro or above. Upgrade at aretica.ai.",
    agents:        "Sub-agents require Pro or above. Upgrade at aretica.ai.",
    softLock:      "Soft lock requires Pro or above. Upgrade at aretica.ai.",
  };
  return messages[feature] ?? `This feature requires a paid plan. Upgrade at aretica.ai.`;
}
