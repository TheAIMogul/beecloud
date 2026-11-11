import { DEFAULT_TZ, Json } from "./env";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, kind: "full" | "clock" | "day"): Intl.DateTimeFormat {
  const key = `${tz}|${kind}`;
  let f = fmtCache.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === "day"
        ? { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }
        : kind === "clock"
          ? { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }
          : { timeZone: tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    f = new Intl.DateTimeFormat(kind === "day" ? "en-CA" : "en-US", opts);
    fmtCache.set(key, f);
  }
  return f;
}

export function fmtTime(ms: number | string | null | undefined, tz = DEFAULT_TZ, withDate = true): string {
  if (ms === null || ms === undefined || ms === "") return "";
  return fmt(tz, withDate ? "full" : "clock").format(new Date(Number(ms)));
}

export const dateKey = (ms: number | string, tz = DEFAULT_TZ): string => fmt(tz, "day").format(new Date(Number(ms)));

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function conversationMarkdown(c: Json, tz: string, includeTranscript = true): string {
  const lines: string[] = [];
  lines.push(`# ${c.short_summary || `Conversation ${c.id}`}`, "");
  lines.push(`- id: ${c.id}`);
  lines.push(`- start: ${fmtTime(c.start_time, tz)}`);
  if (c.end_time) lines.push(`- end: ${fmtTime(c.end_time, tz)}`);
  if (c.primary_location?.address) lines.push(`- location: ${c.primary_location.address}`);
  lines.push(`- state: ${c.state}`, "");
  if (c.summary) lines.push(String(c.summary).trim(), "");
  if (includeTranscript) {
    const utterances = (c.transcriptions || []).flatMap((t: Json) => t.utterances || []);
    if (utterances.length) {
      lines.push("## Transcript", "");
      for (const u of utterances) {
        const who = u.speaker ? `${u.speaker}: ` : "";
        lines.push(`[${fmtTime(u.spoken_at, tz, false)}] ${who}${u.text}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export function dailyMarkdown(d: Json, tz: string): string {
  return [
    `# Daily summary ${dateKey(d.date_time, tz)}`,
    "",
    `- id: ${d.id}`,
    `- conversations: ${d.conversations_count ?? d.conversations?.length ?? "?"}`,
    "",
    d.short_summary ? `**${d.short_summary}**\n` : "",
    String(d.summary || "").trim(),
    d.email_summary ? `\n## Email\n\n${d.email_summary}` : "",
    d.calendar_summary ? `\n## Calendar\n\n${d.calendar_summary}` : "",
    "",
  ].join("\n");
}

export function insightMarkdown(i: Json, tz: string): string {
  const actions = (i.suggested_actions || []).map((a: any) => `- ${typeof a === "string" ? a : a.text || a.title || JSON.stringify(a)}`);
  return [`# ${i.title}`, "", `- id: ${i.id}`, `- generated: ${fmtTime(i.generated_at, tz)}`, "", i.description || "", actions.length ? `\n## Suggested actions\n\n${actions.join("\n")}` : "", ""].join("\n");
}

export const journalMarkdown = (j: Json, tz: string) => [`# Voice note ${fmtTime(j.created_at, tz)}`, "", `- id: ${j.id}`, `- state: ${j.state}`, "", String(j.text || "").trim(), ""].join("\n");

export const todoLine = (t: Json, tz: string) => `- [${t.completed ? "x" : " "}] ${t.text}${t.alarm_at ? ` (due ${fmtTime(t.alarm_at, tz)})` : ""} — id ${t.id}`;
export const factLine = (f: Json) => `- ${f.text}${f.tags?.length ? ` [${f.tags.join(", ")}]` : ""}${f.confirmed ? "" : " (unconfirmed)"} — id ${f.id}`;

export const todosMarkdown = (todos: Json[], tz: string) => ["# Bee todos", "", ...todos.map((t) => todoLine(t, tz)), ""].join("\n");
export const factsMarkdown = (facts: Json[]) => ["# Bee facts", "", ...facts.map(factLine), ""].join("\n");

export function briefMarkdown(b: Json, tz: string, day: string): string {
  const events = (b.calendar_events || []).map((e: Json) => `- ${e.is_all_day ? "All day" : fmtTime(Date.parse(e.start_time), tz, false)}: ${e.summary}${e.location ? ` (${e.location})` : ""}`);
  const emails = (b.emails || []).map((e: Json) => `- ${e.from}: ${e.subject}${e.concise_summary || e.snippet ? ` — ${e.concise_summary || e.snippet}` : ""}`);
  return [`# Brief ${day}`, "", "## Calendar", "", ...(events.length ? events : ["(none)"]), "", "## Emails", "", ...(emails.length ? emails : ["(none)"]), ""].join("\n");
}

export const minutesBetween = (start: any, end: any): number | null => (start && end ? Math.round((Number(end) - Number(start)) / 6000) / 10 : null);
