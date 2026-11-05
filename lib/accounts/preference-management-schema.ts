import { z } from "zod";

const timezone = z.string().trim().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}, "Choose a recognised IANA timezone.");
const profileFields = {
  preferredName: z.string().trim().max(80),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  timezone,
  communicationPreference: z.enum(["concise", "detailed"]),
  financialGoals: z.string().trim().max(2000),
};
const reminderFields = {
  morningEnabled: z.boolean(), commuteEnabled: z.boolean(), eveningEnabled: z.boolean(),
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  commuteTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  eveningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
};
const notificationFields = {
  paymentMentions: z.boolean(), outgoingMentions: z.boolean(), paymentPush: z.boolean(),
  paymentPreview: z.boolean(), billReminders: z.boolean(), weeklyOverview: z.boolean(),
};
const hasChanges = (value: object) => Object.keys(value).length > 0;
export const profilePreferenceSchema = z.strictObject(profileFields);
export const reminderPreferenceSchema = z.strictObject(reminderFields);
export const notificationPreferenceSchema = z.strictObject(notificationFields);
export const profilePreferencePatchSchema = profilePreferenceSchema.partial().refine(hasChanges, "Choose a profile setting to change.");
export const reminderPreferencePatchSchema = reminderPreferenceSchema.partial().refine(hasChanges, "Choose a reminder setting to change.");
export const notificationPreferencePatchSchema = notificationPreferenceSchema.partial().refine(hasChanges, "Choose a notification setting to change.");

const revision = z.string().min(1).max(80);
export const profilePreferenceSnapshotSchema = z.strictObject({ values: profilePreferenceSchema, revision });
export const reminderPreferenceSnapshotSchema = z.strictObject({ values: reminderPreferenceSchema, revision, timezone });
export const notificationPreferenceSnapshotSchema = z.strictObject({ values: notificationPreferenceSchema, revision });
const proposedReminderPatch = z.strictObject({
  morningEnabled: z.boolean().optional(), commuteEnabled: z.boolean().optional(), eveningEnabled: z.boolean().optional(),
  // Keep ambiguous user wording such as "8" intact so the server asks AM/PM.
  morningTime: z.string().trim().min(1).max(40).optional(),
  commuteTime: z.string().trim().min(1).max(40).optional(),
  eveningTime: z.string().trim().min(1).max(40).optional(),
}).refine(hasChanges, "Choose a reminder setting to change.");

export const preferenceActionSchemas = [
  z.strictObject({ type: z.literal("read_settings"), section: z.enum(["profile", "reminders", "notifications", "all"]).nullable().optional() }),
  z.strictObject({ type: z.literal("update_profile_settings"), changes: profilePreferencePatchSchema }),
  z.strictObject({ type: z.literal("update_reminder_settings"), changes: proposedReminderPatch }),
  z.strictObject({ type: z.literal("update_notification_settings"), changes: notificationPreferencePatchSchema }),
] as const;
const originUpdateId = z.string().regex(/^\d+$/);
export const preferencePendingSchemas = [
  z.strictObject({ type: z.literal("update_profile_settings"), originUpdateId, changes: profilePreferencePatchSchema, expected: profilePreferenceSnapshotSchema }),
  z.strictObject({ type: z.literal("update_reminder_settings"), originUpdateId, changes: reminderPreferencePatchSchema, expected: reminderPreferenceSnapshotSchema }),
  z.strictObject({ type: z.literal("update_notification_settings"), originUpdateId, changes: notificationPreferencePatchSchema, expected: notificationPreferenceSnapshotSchema }),
] as const;

export const preferenceActionSchema = z.discriminatedUnion("type", preferenceActionSchemas);
export const preferencePendingSchema = z.discriminatedUnion("type", preferencePendingSchemas);
export type PreferenceAction = z.infer<typeof preferenceActionSchema>;
export type PreferencePending = z.infer<typeof preferencePendingSchema>;
export type ProfilePreferences = z.infer<typeof profilePreferenceSchema>;
export type ReminderPreferences = z.infer<typeof reminderPreferenceSchema>;
export type ManagedNotificationPreferences = z.infer<typeof notificationPreferenceSchema>;
export type ProfilePreferenceSnapshot = z.infer<typeof profilePreferenceSnapshotSchema>;
export type ReminderPreferenceSnapshot = z.infer<typeof reminderPreferenceSnapshotSchema>;
export type NotificationPreferenceSnapshot = z.infer<typeof notificationPreferenceSnapshotSchema>;
