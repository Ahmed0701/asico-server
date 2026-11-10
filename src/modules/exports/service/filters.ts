import { formatBoolean, formatDate, formatDateTime } from "../../../shared/export/format.js";
import {
  FILTER_LABELS,
  PARTY_STATUS_LABELS,
  PRIORITY_LABELS,
  SITE_REPORT_TYPE_LABELS,
  SMALL_WORK_STATUS_LABELS,
  WEATHER_LABELS,
  WORK_STATUS_LABELS,
} from "../../../shared/export/labels.js";

const PAGING = new Set(["page", "limit"]);

// The filters whose value is a code with a label. Party statuses, work statuses and small work statuses share the key
// "status": a code that two of them have (DONE) has the same label in both.
const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  status: { ...PARTY_STATUS_LABELS, ...WORK_STATUS_LABELS, ...SMALL_WORK_STATUS_LABELS },
  priority: PRIORITY_LABELS,
  weather: WEATHER_LABELS,
  type: SITE_REPORT_TYPE_LABELS,
};

function labelOf(key: string, value: unknown): string | undefined {
  const labels = VALUE_LABELS[key];
  return labels !== undefined && typeof value === "string" && Object.hasOwn(labels, value)
    ? labels[value]
    : undefined;
}

// A date that is the start or the end of a UTC day came from a date alone, so it is shown as one.
function formatBoundary(date: Date): string {
  const time = date.getTime() % 86_400_000;
  return time === 0 || time === 86_399_999 ? formatDate(date) : formatDateTime(date);
}

function describe(key: string, value: unknown): string {
  if (value instanceof Date) return formatBoundary(value);
  if (typeof value === "boolean") return formatBoolean(value);
  const label = labelOf(key, value);
  if (label !== undefined) return label;
  if (key === "sort" && typeof value === "string") return value.replace(":", " ");
  return String(value);
}

// The filters that were applied, one "Label: value" line each, in the order the labels are listed (status first,
// sort last) rather than the order the query happened to arrive in. Paging is not a filter.
export function describeFilters(query: object): string[] {
  const order = Object.keys(FILTER_LABELS);
  const rank = (key: string): number => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  const lines: string[] = [];
  const entries = Object.entries(query)
    .filter(([key, value]) => !PAGING.has(key) && value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => rank(a) - rank(b));
  for (const [key, value] of entries) {
    lines.push(`${FILTER_LABELS[key] ?? key}: ${describe(key, value)}`);
  }
  return lines;
}

// The same filters as data, for the audit entry.
export function appliedFilters(query: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(([key, value]) => !PAGING.has(key) && value !== undefined && value !== ""),
  );
}
