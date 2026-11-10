import type { LocaleCode } from "../../shared/constants/enums.js";
import ar from "./locales/ar.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

export type MessageKey = keyof typeof en;

const dictionaries: Record<LocaleCode, Record<MessageKey, string>> = { en, ar };

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(en, value);
}

export function t(locale: LocaleCode, key: MessageKey): string {
  return dictionaries[locale][key];
}
