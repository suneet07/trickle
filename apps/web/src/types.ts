// Shared API response types so the UI is typed end-to-end (no more `any`).
// These mirror what the API routes return.

export type LeadStatus =
  | "pending"
  | "contacted"
  | "followup"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "do_not_contact";

export type CampaignStatus = "draft" | "scheduled" | "running" | "paused" | "done";
export type AccountStatus = "active" | "paused" | "quarantined";
export type MessageDirection = "out" | "in";
export type MessageStatus = "planned" | "queued" | "sent" | "bounced" | "failed" | "canceled";
export type Variant = "A" | "B";

export interface Region {
  id: string;
  name: string;
  states: string[];
  timezone: string;
  createdAt: string;
  _count?: { leads: number };
}

export interface Lead {
  id: string;
  name: string | null;
  email: string;
  company: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string;
  status: LeadStatus;
  notes: string | null;
  customFields: Record<string, string> | null;
  snoozeUntil: string | null;
  regionId: string | null;
  accountId: string | null;
  region?: { id?: string; name: string } | null;
  account?: { id?: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  direction: MessageDirection;
  status: MessageStatus;
  variant: Variant;
  stepIndex: number;
  isManualReply: boolean;
  subject: string;
  body: string;
  gmailThreadId: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  error: string | null;
  createdAt: string;
  leadId: string;
  campaignId: string | null;
  accountId: string;
}

export interface FollowUpStep {
  dayOffset: number;
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  subjectTemplate: string;
  bodyTemplate: string;
  subjectVariantB: string | null;
  bodyVariantB: string | null;
  abEnabled: boolean;
  followUpsJson: FollowUpStep[];
  filtersJson: Record<string, unknown>;
  isHtml: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  unsubHeader: boolean;
  footerOverride: string | null;
  placementTestConfirmed: boolean;
  scheduledStartAt: string | null;
  archivedAt: string | null;
  regionId: string | null;
  region?: { name: string } | null;
  createdAt: string;
  _count?: { messages: number };
}

export interface Account {
  id: string;
  email: string;
  displayName: string | null;
  status: AccountStatus;
  healthScore: number;
  dailyCapCold: number;
  warmupVolumeManual: number;
  warmedUp: boolean;
  warmupEnabled: boolean;
  warmupTarget: number;
  warmupSentTotal: number;
  signature: string | null;
  sendAsEmail: string | null;
  sendAsName: string | null;
  hourlyCap: number | null;
  minGapMinutes: number | null;
  sendWindowsJson: SendWindow[] | null;
  pausedUntil: string | null;
  connected: boolean;
  createdAt: string;
}

export interface SendWindow {
  startMin: number; // minutes from local midnight
  endMin: number;
  weight: number; // 0..1
}

export interface CapBreakdown {
  base: number;
  warmupVolume: number;
  headroomAfterWarmup: number;
  healthMultiplier: number;
  rampFactor: number;
  effectiveCap: number;
  usedToday: number;
  remainingToday: number;
}

export interface SchedulePlan {
  date: string;
  inboxes: {
    id: string;
    email: string;
    status: AccountStatus;
    effectiveCap: number;
    usedToday: number;
    remainingToday: number;
    plannedCount: number;
    queuedCount: number;
    backlogCount: number;
    hourly: Record<string, number>;
    slots: {
      id: string;
      status: MessageStatus;
      stepIndex: number;
      scheduledAt: string | null;
      lead: { name: string | null; email: string; timezone: string };
      campaign: { name: string } | null;
    }[];
  }[];
}

export interface Suppression {
  id: string;
  email: string;
  reason: "unsub" | "bounce" | "complaint" | "manual";
  detail: string | null;
  createdAt: string;
}

export interface BlocklistEntry {
  id: string;
  domain: string;
  note: string | null;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  kind: "event" | "audit";
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface HistoryPoint {
  date: string;
  sent: number;
  bounces: number;
  replies: number;
}

export interface AbReport {
  variants: { variant: Variant; sent: number; replies: number; opens: number; replyRate: number }[];
}

export interface LeadDetailResponse {
  lead: Lead & { messages: Message[] };
  suppressed: boolean;
  nextStep: Message | null;
}

export interface Paged<T> {
  total: number;
  leads?: T[];
  items?: T[];
}

export interface AppConfig {
  version: string;
  appBaseUrl: string;
  sendLive: boolean;
  globalDailyCap: number;
  perInboxTotalCap: number;
  holidayCalendar: "us" | "none";
  defaultTimezone: string;
  sender: { senderName: string; title: string; company: string; postalAddress: string };
  senderFooterConfigured: boolean;
  googleConfigured: boolean;
  loginMethods: { google: boolean; password: boolean };
  apiTokenEnabled: boolean;
  alertChannel: string;
}
