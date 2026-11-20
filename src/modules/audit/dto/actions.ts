import type { MessageKey } from "../../../core/i18n/index.js";
import { t } from "../../../core/i18n/index.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";

// The actions that audit entries are written with. The code is what is stored (and what the action filter takes); the
// label, in the language of the request, is what a person reads. Every action the application writes is here, and a
// test fails if one is added to the code without a label.
export const ACTION_LABEL_KEYS = {
  "area.create": "actions.area.create",
  "area.update": "actions.area.update",
  "area.delete": "actions.area.delete",
  "auth.login": "actions.auth.login",
  "auth.logout": "actions.auth.logout",
  "auth.password_changed": "actions.auth.password_changed",
  "auth.password_reset": "actions.auth.password_reset",
  "auth.signup": "actions.auth.signup",
  "civil_engineer.create": "actions.civil_engineer.create",
  "civil_engineer.update": "actions.civil_engineer.update",
  "civil_engineer.delete": "actions.civil_engineer.delete",
  "contractor.create": "actions.contractor.create",
  "contractor.update": "actions.contractor.update",
  "contractor.delete": "actions.contractor.delete",
  "contractor.import": "actions.contractor.import",
  "daily_labour.create": "actions.daily_labour.create",
  "daily_labour.update": "actions.daily_labour.update",
  "daily_labour.delete": "actions.daily_labour.delete",
  "daily_labour.import": "actions.daily_labour.import",
  "daily_report.create": "actions.daily_report.create",
  "daily_report.update": "actions.daily_report.update",
  "daily_report.delete": "actions.daily_report.delete",
  "daily_report.import": "actions.daily_report.import",
  "elec_phase.create": "actions.elec_phase.create",
  "elec_phase.update": "actions.elec_phase.update",
  "elec_phase.delete": "actions.elec_phase.delete",
  "elec_phase.reorder": "actions.elec_phase.reorder",
  "electrical_engineer.create": "actions.electrical_engineer.create",
  "electrical_engineer.update": "actions.electrical_engineer.update",
  "electrical_engineer.delete": "actions.electrical_engineer.delete",
  "export.areas": "actions.export.areas",
  "export.audit-logs": "actions.export.audit-logs",
  "export.civil-engineers": "actions.export.civil-engineers",
  "export.contractor-summary": "actions.export.contractor-summary",
  "export.contractors": "actions.export.contractors",
  "export.daily-labour": "actions.export.daily-labour",
  "export.daily-reports": "actions.export.daily-reports",
  "export.electrical-engineers": "actions.export.electrical-engineers",
  "export.open-works": "actions.export.open-works",
  "export.site-reports": "actions.export.site-reports",
  "export.material-deliveries": "actions.export.material-deliveries",
  "export.payments": "actions.export.payments",
  "export.progress-payments": "actions.export.progress-payments",
  "export.material-balance": "actions.export.material-balance",
  "export.small-works": "actions.export.small-works",
  "export.villas": "actions.export.villas",
  "open_work.create": "actions.open_work.create",
  "open_work.update": "actions.open_work.update",
  "open_work.delete": "actions.open_work.delete",
  "open_work.import": "actions.open_work.import",
  "site_report.create": "actions.site_report.create",
  "site_report.update": "actions.site_report.update",
  "site_report.delete": "actions.site_report.delete",
  "site_report.import": "actions.site_report.import",
  "small_work.create": "actions.small_work.create",
  "small_work.update": "actions.small_work.update",
  "small_work.delete": "actions.small_work.delete",
  "small_work.import": "actions.small_work.import",
  "user.create": "actions.user.create",
  "user.update": "actions.user.update",
  "user.activate": "actions.user.activate",
  "user.deactivate": "actions.user.deactivate",
  "user.delete": "actions.user.delete",
  "user.password_reset_issued": "actions.user.password_reset_issued",
  "user.permissions_replaced": "actions.user.permissions_replaced",
  "user.profile_updated": "actions.user.profile_updated",
  "villa.create": "actions.villa.create",
  "villa.update": "actions.villa.update",
  "villa.delete": "actions.villa.delete",
  "villa.progress": "actions.villa.progress",
  "villa.import": "actions.villa.import",
  "villa.mew_follow_up": "actions.villa.mew_follow_up",
  "villa.mew_follow_up_undo": "actions.villa.mew_follow_up_undo",
  "villa.mew_inspection": "actions.villa.mew_inspection",
  "villa.mew_inspection_undo": "actions.villa.mew_inspection_undo",
  "villa.mew_inspection_passed": "actions.villa.mew_inspection_passed",
  "villa.mew_inspection_passed_undo": "actions.villa.mew_inspection_passed_undo",
  "maintenance.create": "actions.maintenance.create",
  "maintenance.update": "actions.maintenance.update",
  "maintenance.delete": "actions.maintenance.delete",
  "maintenance.solved": "actions.maintenance.solved",
  "maintenance.solved_undo": "actions.maintenance.solved_undo",
  "owner_note.create": "actions.owner_note.create",
  "owner_note.update": "actions.owner_note.update",
  "owner_note.delete": "actions.owner_note.delete",
  "owner_note.done": "actions.owner_note.done",
  "owner_note.done_undo": "actions.owner_note.done_undo",
  "foreman_mission.create": "actions.foreman_mission.create",
  "foreman_mission.update": "actions.foreman_mission.update",
  "foreman_mission.delete": "actions.foreman_mission.delete",
  "foreman_mission.done": "actions.foreman_mission.done",
  "foreman_mission.done_undo": "actions.foreman_mission.done_undo",
  "payment.create": "actions.payment.create",
  "payment.update": "actions.payment.update",
  "payment.delete": "actions.payment.delete",
  "payment.paid": "actions.payment.paid",
  "payment.paid_undo": "actions.payment.paid_undo",
  "payment.file_upload": "actions.payment.file_upload",
  "payment.file_delete": "actions.payment.file_delete",
  "payment.import": "actions.payment.import",
  "variation_order.create": "actions.variation_order.create",
  "variation_order.update": "actions.variation_order.update",
  "variation_order.delete": "actions.variation_order.delete",
  "variation_order.paid": "actions.variation_order.paid",
  "variation_order.paid_undo": "actions.variation_order.paid_undo",
  "variation_order.file_upload": "actions.variation_order.file_upload",
  "variation_order.file_delete": "actions.variation_order.file_delete",
  "factory.create": "actions.factory.create",
  "factory.update": "actions.factory.update",
  "factory.delete": "actions.factory.delete",
  "material_delivery.create": "actions.material_delivery.create",
  "material_delivery.update": "actions.material_delivery.update",
  "material_delivery.delete": "actions.material_delivery.delete",
  "material_delivery.note_upload": "actions.material_delivery.note_upload",
  "material_delivery.note_delete": "actions.material_delivery.note_delete",
  "material_delivery.import": "actions.material_delivery.import",
  "material_item.create": "actions.material_item.create",
  "material_item.update": "actions.material_item.update",
  "material_item.delete": "actions.material_item.delete",
  "villa.material_requirements": "actions.villa.material_requirements",
  "villa.mew_states": "actions.villa.mew_states",
  "villa.finance": "actions.villa.finance",
  "villa.vendors": "actions.villa.vendors",
  "villa.vendors_add": "actions.villa.vendors_add",
  "villa.vendors_remove": "actions.villa.vendors_remove",
  "overhead.create": "actions.overhead.create",
  "overhead.update": "actions.overhead.update",
  "overhead.delete": "actions.overhead.delete",
  "overhead_expense.create": "actions.overhead_expense.create",
  "overhead_expense.update": "actions.overhead_expense.update",
  "overhead_expense.delete": "actions.overhead_expense.delete",
  "overhead_expense.file_upload": "actions.overhead_expense.file_upload",
  "overhead_expense.file_delete": "actions.overhead_expense.file_delete",
  "villa_document.upload": "actions.villa_document.upload",
  "villa_document.delete": "actions.villa_document.delete",
  "villa_image.upload": "actions.villa_image.upload",
  "villa_image.delete": "actions.villa_image.delete",
  "mew_report.upload": "actions.mew_report.upload",
  "mew_report.delete": "actions.mew_report.delete",
  "progress_payment.create": "actions.progress_payment.create",
  "progress_payment.delete": "actions.progress_payment.delete",
  "progress_payment.import": "actions.progress_payment.import",
  "material_order.update": "actions.material_order.update",
} as const satisfies Record<string, MessageKey>;

export type AuditAction = keyof typeof ACTION_LABEL_KEYS;

export function isAuditAction(code: string): code is AuditAction {
  return Object.hasOwn(ACTION_LABEL_KEYS, code);
}

// Entries written before the villa rename keep the codes they were written under (the log is append-only). Each is the
// same action as today's, so it is labelled, and filtered, as that action.
export const LEGACY_ACTIONS = {
  "project.create": "villa.create",
  "project.update": "villa.update",
  "project.delete": "villa.delete",
  "project_file.upload": "villa_document.upload",
  "project_file.delete": "villa_document.delete",
  "export.projects": "export.villas",
} as const satisfies Record<string, AuditAction>;

export type LegacyAction = keyof typeof LEGACY_ACTIONS;

// Actions of features that no longer exist, so there is no action of today to fold them into. They keep their code, and
// their own label; they are listed as an option only while an entry written with them is in the log.
export const RETIRED_ACTION_LABEL_KEYS = {
  "project.material_request_update": "actions.legacy.materialRequestUpdate",
  "export.wall-piping": "actions.legacy.exportWallPiping",
  // The automatic open works, which followed the phase progress, were removed: all open works are added by hand now.
  "open_work.auto_sync": "actions.open_work.auto_sync",
  // Ready for inspection was removed: the MEW follow-up and inspection lists took its place.
  "villa.ready_for_inspection": "actions.villa.ready_for_inspection",
  "villa.ready_for_inspection_undo": "actions.villa.ready_for_inspection_undo",
} as const satisfies Record<string, MessageKey>;

type RetiredAction = keyof typeof RETIRED_ACTION_LABEL_KEYS;

function isLegacyAction(code: string): code is LegacyAction {
  return Object.hasOwn(LEGACY_ACTIONS, code);
}

function isRetiredAction(code: string): code is RetiredAction {
  return Object.hasOwn(RETIRED_ACTION_LABEL_KEYS, code);
}

// The action an entry's code stands for today; a code that is not a legacy one is its own.
export function canonicalAction(code: string): string {
  return isLegacyAction(code) ? LEGACY_ACTIONS[code] : code;
}

// Every code stored for an action: the action filter takes any of them and matches all.
export function actionCodes(code: string): string[] {
  const canonical = canonicalAction(code);
  return [
    canonical,
    ...Object.keys(LEGACY_ACTIONS).filter((legacy) => canonicalAction(legacy) === canonical),
  ];
}

// Every action of today, sorted: what the action filter offers even before an entry exists for it.
export const KNOWN_ACTIONS: readonly AuditAction[] = (Object.keys(ACTION_LABEL_KEYS) as AuditAction[]).sort();

// An action this list does not know (a new one, or an old one) keeps its code as its label.
export function actionLabel(code: string, locale: LocaleCode): string {
  const canonical = canonicalAction(code);
  if (isAuditAction(canonical)) {
    return t(locale, ACTION_LABEL_KEYS[canonical]);
  }
  return isRetiredAction(code) ? t(locale, RETIRED_ACTION_LABEL_KEYS[code]) : code;
}
