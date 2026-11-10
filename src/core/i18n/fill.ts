// Puts values into the {name} placeholders of a translated text. A placeholder with no value is left as it is.
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
