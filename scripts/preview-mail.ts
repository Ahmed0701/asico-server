import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderResetPasswordEmail } from "../src/core/mail/templates/resetPassword.js";

// Renders the password reset email in English and Arabic, for the person who asked for it and for one an
// administrator started, into a temp folder, so the files can be opened in a browser. Sends nothing.
const directory = join(tmpdir(), "asico-mail-preview");
await mkdir(directory, { recursive: true });

const link = "https://app.example.test/reset-password?token=EXAMPLE-TOKEN-NOT-REAL-0123456789abcdef";
const samples = [
  { locale: "en", reason: "requested", name: "Sara Hassan" },
  { locale: "ar", reason: "requested", name: "سارة حسن" },
  { locale: "en", reason: "admin", name: "Sara Hassan" },
  { locale: "ar", reason: "admin", name: "سارة حسن" },
] as const;

for (const sample of samples) {
  const { html, text } = renderResetPasswordEmail({ ...sample, link, minutes: 30 });
  const base = join(directory, `reset-password.${sample.locale}${sample.reason === "admin" ? ".admin" : ""}`);
  await writeFile(`${base}.html`, html, "utf8");
  await writeFile(`${base}.txt`, text, "utf8");
  console.log(`${base}.html`);
}
console.log(`\nOpen the .html files in a browser. Folder: ${directory}`);
