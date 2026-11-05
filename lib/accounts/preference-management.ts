import { isDeepStrictEqual } from "node:util";
import type { SupabaseSettings } from "@/lib/config";
import { saveConfirmation, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { pushConfiguration } from "@/lib/notifications/push";
import { loadRecoveryStatus } from "@/lib/notifications/recovery";
import { notificationPolicyAvailable } from "@/lib/notifications/schema-ready";
import { query } from "@/lib/supabase/connection";
import {
  preferenceActionSchema, preferencePendingSchema, profilePreferenceSnapshotSchema,
  reminderPreferenceSnapshotSchema, notificationPreferenceSnapshotSchema,
  profilePreferencePatchSchema, reminderPreferencePatchSchema, notificationPreferencePatchSchema,
  type PreferenceAction, type PreferencePending, type ProfilePreferences, type ReminderPreferences,
  type ManagedNotificationPreferences, type ProfilePreferenceSnapshot, type ReminderPreferenceSnapshot,
  type NotificationPreferenceSnapshot,
} from "./preference-management-schema";

export type { PreferenceAction, PreferencePending } from "./preference-management-schema";
export type PreferenceManagementStore = {
  readProfile(ownerId: string): Promise<ProfilePreferenceSnapshot>;
  readReminders(ownerId: string): Promise<ReminderPreferenceSnapshot>;
  readNotifications(ownerId: string): Promise<NotificationPreferenceSnapshot>;
  updateProfile(ownerId: string, expected: ProfilePreferenceSnapshot, changes: Partial<ProfilePreferences>): Promise<boolean>;
  updateReminders(ownerId: string, expected: ReminderPreferenceSnapshot, changes: Partial<ReminderPreferences>): Promise<boolean>;
  updateNotifications(ownerId: string, expected: NotificationPreferenceSnapshot, changes: Partial<ManagedNotificationPreferences>): Promise<boolean>;
  pushReady(): Promise<boolean>;
};
type PreferenceContext = ActionContext & { preferences?: PreferenceManagementStore | null };
export type PreferenceExecute = <T extends Record<string, unknown>>(settings: SupabaseSettings, sql: string, values?: unknown[]) => Promise<T[]>;

const PROFILE_COLUMNS = { preferredName: "preferred_name", currency: "currency", timezone: "timezone", communicationPreference: "communication_preference", financialGoals: "financial_goals" } as const;
const REMINDER_COLUMNS = { morningEnabled: "morning_enabled", commuteEnabled: "commute_enabled", eveningEnabled: "evening_enabled", morningTime: "morning_minute", commuteTime: "commute_minute", eveningTime: "evening_minute" } as const;
const NOTIFICATION_COLUMNS = { paymentMentions: "payment_mentions", outgoingMentions: "outgoing_mentions", paymentPush: "payment_push", paymentPreview: "payment_preview", billReminders: "bill_reminders", weeklyOverview: "weekly_overview" } as const;
const profileJSON = (alias: string) => `jsonb_build_object(${Object.entries(PROFILE_COLUMNS).map(([key, column]) => `'${key}',${alias}.${column}`).join(",")})`;
const minuteTime = (value: string) => `(lpad((${value}/60)::text,2,'0')||':'||lpad((${value}%60)::text,2,'0'))`;
const reminderJSON = (alias: string) => `jsonb_build_object(${Object.entries(REMINDER_COLUMNS).map(([key, column]) => `'${key}',${key.endsWith("Time") ? minuteTime(`${alias}.${column}`) : `${alias}.${column}`}`).join(",")})`;
const notificationJSON = (alias: string) => `jsonb_build_object(${Object.entries(NOTIFICATION_COLUMNS).map(([key, column]) => `'${key}',${alias}.${column}`).join(",")})`;
const initialNotifications: ManagedNotificationPreferences = { paymentMentions: false, outgoingMentions: false, paymentPush: false, paymentPreview: false, billReminders: false, weeklyOverview: false };

/** Partial, compare-and-set writes never call the all-settings save path or touch Telegram bindings. */
export function createSupabasePreferenceManagementStore(settings: SupabaseSettings, options: { execute?: PreferenceExecute; pushReady?: () => Promise<boolean> } = {}): PreferenceManagementStore {
  const execute = options.execute ?? query;
  const pushReady = options.pushReady ?? (async () => {
    const [recovery, policy] = await Promise.all([loadRecoveryStatus(settings, { execute }), notificationPolicyAvailable(settings, execute)]);
    return pushConfiguration().ready && process.env.ALFRED_PUSH_DELIVERY_ENABLED === "true" && recovery.ready && policy;
  });
  return {
    async readProfile(ownerId) {
      const rows = await execute(settings, `select ${profileJSON("p")} as values,p.updated_at::text as revision from public.profiles p where p.id=$1::uuid`, [ownerId]);
      return profilePreferenceSnapshotSchema.parse(rows[0]);
    },
    async readReminders(ownerId) {
      const rows = await execute(settings, `select ${reminderJSON("r")} as values,r.updated_at::text as revision,p.timezone from public.reminder_preferences r join public.profiles p on p.id=r.owner_id where r.owner_id=$1::uuid`, [ownerId]);
      return reminderPreferenceSnapshotSchema.parse(rows[0]);
    },
    async readNotifications(ownerId) {
      const rows = await execute(settings, `select ${notificationJSON("p")} as values,p.updated_at::text as revision,p.owner_id is not null as present
        from public.profiles owner_profile left join public.notification_preferences p on p.owner_id=owner_profile.id where owner_profile.id=$1::uuid`, [ownerId]);
      if (!rows[0]) throw new Error("The settings profile is unavailable.");
      // A successful read of a known profile with no opt-in row means the
      // existing all-off defaults. Failed reads never fall back to defaults.
      return notificationPreferenceSnapshotSchema.parse(rows[0].present === false ? { values: { ...initialNotifications }, revision: "absent" } : { values: rows[0].values, revision: rows[0].revision });
    },
    async updateProfile(ownerId, expected, changes) {
      const checked = profilePreferencePatchSchema.parse(changes);
      profilePreferenceSnapshotSchema.parse(expected);
      const values: unknown[] = [ownerId, expected.revision, JSON.stringify(expected.values)];
      const assignments = Object.entries(checked).map(([key, value]) => { values.push(value); return `${PROFILE_COLUMNS[key as keyof ProfilePreferences]}=$${values.length}`; });
      const rows = await execute(settings, `update public.profiles p set ${assignments.join(",")},updated_at=now() where p.id=$1::uuid and p.updated_at::text=$2 and ${profileJSON("p")}=$3::jsonb returning p.id`, values);
      return rows.length === 1;
    },
    async updateReminders(ownerId, expected, changes) {
      const checked = reminderPreferencePatchSchema.parse(changes);
      reminderPreferenceSnapshotSchema.parse(expected);
      const values: unknown[] = [ownerId, expected.revision, JSON.stringify(expected.values), expected.timezone];
      const assignments = Object.entries(checked).map(([key, value]) => {
        const next = key.endsWith("Time") ? Number(String(value).slice(0, 2)) * 60 + Number(String(value).slice(3)) : value;
        values.push(next); return `${REMINDER_COLUMNS[key as keyof ReminderPreferences]}=$${values.length}`;
      });
      // Lock the timezone and preference rows together before comparing the review.
      const rows = await execute(settings, `with current_snapshot as materialized (
        select r.owner_id,r.updated_at::text as revision,${reminderJSON("r")} as values,p.timezone
        from public.reminder_preferences r join public.profiles p on p.id=r.owner_id where r.owner_id=$1::uuid for update of r,p
      ) update public.reminder_preferences r set ${assignments.join(",")},updated_at=now() from current_snapshot c
        where r.owner_id=c.owner_id and c.revision=$2 and c.values=$3::jsonb and c.timezone=$4 returning r.owner_id`, values);
      return rows.length === 1;
    },
    async updateNotifications(ownerId, expected, changes) {
      const patch = notificationPreferencePatchSchema.parse(changes);
      notificationPreferenceSnapshotSchema.parse(expected);
      if (needsPush(patch) && !await pushReady()) return false;
      const values = [ownerId, expected.revision, JSON.stringify(expected.values), patch.paymentMentions ?? null, patch.outgoingMentions ?? null, patch.paymentPush ?? null, patch.paymentPreview ?? null, patch.billReminders ?? null, patch.weeklyOverview ?? null];
      if (expected.revision === "absent") {
        if (!isDeepStrictEqual(expected.values, initialNotifications)) return false;
        const rows = await execute(settings, `insert into public.notification_preferences
          (owner_id,payment_mentions,outgoing_mentions,payment_push,payment_preview,bill_reminders,weekly_overview,
           payment_mentions_since,outgoing_mentions_since,payment_push_since,bill_reminders_since,weekly_overview_since,payment_epoch,bill_epoch,weekly_epoch)
          values($1::uuid,$2::boolean,$3::boolean,$4::boolean,$5::boolean,$6::boolean,$7::boolean,
            case when $2 then now() end,case when $3 then now() end,case when $4 then now() end,case when $6 then now() end,case when $7 then now() end,
            case when $4 then 1 else 0 end,case when $6 then 1 else 0 end,case when $7 then 1 else 0 end)
          on conflict(owner_id) do nothing returning owner_id`, [ownerId,patch.paymentMentions??false,patch.outgoingMentions??false,patch.paymentPush??false,patch.paymentPreview??false,patch.billReminders??false,patch.weeklyOverview??false]);
        return rows.length === 1;
      }
      const rows = await execute(settings, `update public.notification_preferences p set
        payment_mentions=coalesce($4::boolean,p.payment_mentions),outgoing_mentions=coalesce($5::boolean,p.outgoing_mentions),
        payment_push=coalesce($6::boolean,p.payment_push),payment_preview=coalesce($7::boolean,p.payment_preview),
        bill_reminders=coalesce($8::boolean,p.bill_reminders),weekly_overview=coalesce($9::boolean,p.weekly_overview),
        payment_mentions_since=case when $4=false then null when $4=true and not p.payment_mentions then now() else p.payment_mentions_since end,
        outgoing_mentions_since=case when $5=false then null when $5=true and not p.outgoing_mentions then now() else p.outgoing_mentions_since end,
        payment_push_since=case when $6=false then null when $6=true and not p.payment_push then now() else p.payment_push_since end,
        bill_reminders_since=case when $8=false then null when $8=true and not p.bill_reminders then now() else p.bill_reminders_since end,
        weekly_overview_since=case when $9=false then null when $9=true and not p.weekly_overview then now() else p.weekly_overview_since end,
        payment_epoch=p.payment_epoch+case when $6::boolean is not null and $6 is distinct from p.payment_push then 1 else 0 end,
        bill_epoch=p.bill_epoch+case when $8::boolean is not null and $8 is distinct from p.bill_reminders then 1 else 0 end,
        weekly_epoch=p.weekly_epoch+case when $9::boolean is not null and $9 is distinct from p.weekly_overview then 1 else 0 end,
        updated_at=now() where p.owner_id=$1::uuid and p.updated_at::text=$2 and ${notificationJSON("p")}=$3::jsonb returning p.owner_id`, values);
      return rows.length === 1;
    },
    pushReady,
  };
}

const labels: Record<string, string> = {
  preferredName: "Preferred name", currency: "Default currency", timezone: "Timezone", communicationPreference: "Reply detail", financialGoals: "Financial goals",
  morningEnabled: "Morning check-in", commuteEnabled: "Commute check-in", eveningEnabled: "Evening check-in", morningTime: "Morning time", commuteTime: "Commute time", eveningTime: "Evening time",
  paymentMentions: "Payment mentions", outgoingMentions: "Outgoing payment mentions", paymentPush: "Payment push", paymentPreview: "Payment preview", billReminders: "Bill reminders", weeklyOverview: "Weekly overview",
};
const formatValue = (value: unknown) => typeof value === "boolean" ? value ? "on" : "off" : JSON.stringify(value);
const needsPush = (changes: Partial<ManagedNotificationPreferences>) => changes.paymentPush === true || changes.billReminders === true || changes.weeklyOverview === true;
const unavailable = "I can't load these settings right now. Nothing was changed. Use Settings once the existing settings storage is available.";
const pushUnavailable = "Push notifications need configured delivery, the current notice policy and a recent healthy scheduled recovery check-in before they can be enabled. Nothing was changed.";
const stale = "Those settings changed since I asked. Please ask again so you can review the current values. Nothing was changed.";
const reminderNote = "These are the existing Telegram check-ins. Delivery requires a linked Telegram chat and the configured reminder job; saving this preference does not guarantee delivery.";
const notificationNote = "This saves your preferences. Push delivery also needs browser permission, a connected device and the configured delivery services; it does not register a device or guarantee delivery.";

/** Bare 12-hour wording is kept ambiguous instead of being treated as morning. */
export function normaliseReminderTime(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  const match = /^(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)$/.exec(value);
  if (!match) return null;
  return `${String(Number(match[1]) % 12 + (match[3] === "pm" ? 12 : 0)).padStart(2, "0")}:${match[2] ?? "00"}`;
}

export async function handlePreferenceManagement(input: PreferenceAction, ctx: PreferenceContext): Promise<Delivery> {
  const parsed = preferenceActionSchema.safeParse(input);
  if (!parsed.success) return { kind: "text", text: "Check the setting names, timezone and values. Nothing was changed." };
  const action = parsed.data, store = ctx.preferences, ownerId = ctx.profile.profileId;
  if (!store) return { kind: "text", text: unavailable };
  try {
    if (action.type === "read_settings") {
      const section = action.section ?? "all";
      const lines: string[] = [];
      if (section === "all" || section === "profile") {
        const snapshot = await store.readProfile(ownerId);
        lines.push("Profile settings:", ...Object.entries(snapshot.values).map(([key, value]) => `${labels[key]}: ${formatValue(value)}`));
      }
      if (section === "all" || section === "reminders") {
        const snapshot = await store.readReminders(ownerId);
        lines.push(`Check-ins (local timezone ${snapshot.timezone}):`, ...Object.entries(snapshot.values).map(([key, value]) => `${labels[key]}: ${formatValue(value)}`), reminderNote);
      }
      if (section === "all" || section === "notifications") {
        const snapshot = await store.readNotifications(ownerId);
        lines.push("Notification preferences:", ...Object.entries(snapshot.values).map(([key, value]) => `${labels[key]}: ${formatValue(value)}`), notificationNote);
      }
      return { kind: "text", text: lines.join("\n") };
    }
    let payload: PreferencePending;
    let note = "";
    if (action.type === "update_profile_settings") {
      payload = { ...action, expected: await store.readProfile(ownerId), originUpdateId: String(ctx.updateId) };
      if (action.changes.currency) note = "This changes the default currency for future entries; existing amounts are not converted.";
      if (action.changes.timezone) note += `${note ? " " : ""}Existing check-in times will use the new timezone.`;
    } else if (action.type === "update_reminder_settings") {
      const changes: Partial<ReminderPreferences> = { ...action.changes };
      for (const key of ["morningTime", "commuteTime", "eveningTime"] as const) if (changes[key] !== undefined) {
        const time = normaliseReminderTime(changes[key]);
        if (!time) return { kind: "text", text: `What exact time should I use for ${labels[key].toLowerCase()}? Please say AM or PM, or use 24-hour HH:MM. Nothing was changed.` };
        changes[key] = time;
      }
      const expected = await store.readReminders(ownerId);
      payload = { type: action.type, changes, expected, originUpdateId: String(ctx.updateId) };
      note = `Times use your current timezone, ${expected.timezone}. ${reminderNote}`;
    } else {
      if (needsPush(action.changes) && !await store.pushReady()) return { kind: "text", text: pushUnavailable };
      payload = { ...action, expected: await store.readNotifications(ownerId), originUpdateId: String(ctx.updateId) };
      note = notificationNote;
    }
    const before = payload.expected.values as Record<string, unknown>;
    const changes = Object.entries(payload.changes).filter(([key, value]) => value !== before[key]);
    if (!changes.length) return { kind: "text", text: "Those settings already match. Nothing was changed." };
    const text = ["Change these settings?", ...changes.map(([key, value]) => `${labels[key]}: ${formatValue(before[key])} → ${formatValue(value)}`), note, "", "Confirm or cancel."].filter(line => line !== "").join("\n");
    if (text.length > 3800) return { kind: "text", text: "That exact before-and-after review is too long for one chat confirmation. Please make this change in Settings so you can review the full values. Nothing was changed." };
    return saveConfirmation(ctx, text, payload);
  } catch { return { kind: "text", text: unavailable }; }
}

export async function executePreferenceManagement(input: PreferencePending, ctx: PreferenceContext): Promise<{ text: string }> {
  const parsed = preferencePendingSchema.safeParse(input);
  if (!parsed.success) return { text: "I couldn't read that settings confirmation. Nothing was changed." };
  const payload = parsed.data, store = ctx.preferences, ownerId = ctx.profile.profileId;
  if (!store) return { text: unavailable };
  try {
    if (payload.type === "update_profile_settings") {
      return { text: await store.updateProfile(ownerId, payload.expected, payload.changes) ? "Saved those profile preferences. Existing financial records were not converted or rewritten." : stale };
    }
    if (payload.type === "update_reminder_settings") {
      return { text: await store.updateReminders(ownerId, payload.expected, payload.changes) ? `Saved those check-in preferences in ${payload.expected.timezone}. ${reminderNote}` : stale };
    }
    if (needsPush(payload.changes) && !await store.pushReady()) return { text: pushUnavailable };
    return { text: await store.updateNotifications(ownerId, payload.expected, payload.changes) ? `Saved those notification preferences. ${notificationNote}` : stale };
  } catch { return { text: "That settings save could not be confirmed. It may have completed. Reload Settings before making another change." }; }
}

export class MemoryPreferenceManagementStore implements PreferenceManagementStore {
  profiles = new Map<string, ProfilePreferenceSnapshot>();
  reminders = new Map<string, ReminderPreferenceSnapshot>();
  notifications = new Map<string, NotificationPreferenceSnapshot>();
  ready = false;
  private counter = 0;
  async pushReady() { return this.ready; }
  private read<T>(rows: Map<string, T>, ownerId: string): T {
    const value = rows.get(ownerId); if (!value) throw new Error("Settings are unavailable."); return structuredClone(value);
  }
  async readProfile(ownerId: string) { return this.read(this.profiles, ownerId); }
  async readReminders(ownerId: string) {
    const result = this.read(this.reminders, ownerId);
    result.timezone = (await this.readProfile(ownerId)).values.timezone;
    return result;
  }
  async readNotifications(ownerId: string) {
    await this.readProfile(ownerId);
    return this.notifications.has(ownerId) ? this.read(this.notifications, ownerId) : { values: { ...initialNotifications }, revision: "absent" };
  }
  private update<T extends { revision: string; values: object }>(rows: Map<string, T>, ownerId: string, expected: T, changes: Partial<T["values"]>): boolean {
    const row = rows.get(ownerId);
    if (!row || !isDeepStrictEqual(row, expected)) return false;
    rows.set(ownerId, { ...row, revision: `memory:${++this.counter}`, values: { ...row.values, ...changes } });
    return true;
  }
  async updateProfile(ownerId: string, expected: ProfilePreferenceSnapshot, changes: Partial<ProfilePreferences>) {
    const parsed = profilePreferencePatchSchema.parse(changes);
    profilePreferenceSnapshotSchema.parse(expected);
    return this.update(this.profiles, ownerId, expected, parsed);
  }
  async updateReminders(ownerId: string, expected: ReminderPreferenceSnapshot, changes: Partial<ReminderPreferences>) {
    const parsed = reminderPreferencePatchSchema.parse(changes);
    reminderPreferenceSnapshotSchema.parse(expected);
    if (this.profiles.get(ownerId)?.values.timezone !== expected.timezone) return false;
    const current = await this.readReminders(ownerId);
    if (!isDeepStrictEqual(current, expected)) return false;
    this.reminders.set(ownerId, current);
    return this.update(this.reminders, ownerId, expected, parsed);
  }
  async updateNotifications(ownerId: string, expected: NotificationPreferenceSnapshot, changes: Partial<ManagedNotificationPreferences>) {
    const parsed = notificationPreferencePatchSchema.parse(changes);
    notificationPreferenceSnapshotSchema.parse(expected);
    if (needsPush(changes) && !await this.pushReady()) return false;
    if (expected.revision === "absent") {
      if (!this.profiles.has(ownerId) || this.notifications.has(ownerId) || !isDeepStrictEqual(expected.values, initialNotifications)) return false;
      this.notifications.set(ownerId, { revision: `memory:${++this.counter}`, values: { ...initialNotifications, ...parsed } });
      return true;
    }
    return this.update(this.notifications, ownerId, expected, parsed);
  }
}
