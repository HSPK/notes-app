import { isReservedFileName, markdownByteLength, validateNewNotePath } from "./model.mjs";

export function calendarDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarWeek(date = new Date()) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((day - first) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function templateTitle(kind, date = new Date()) {
  if (kind === "daily") return calendarDate(date);
  if (kind === "weekly") return calendarWeek(date);
  if (kind === "meeting") return `Meeting-${calendarDate(date)}`;
  if (kind === "blank") return "Untitled";
  throw new Error("Choose a supported note template.");
}

function noteTitle(value) {
  const title = value.trim();
  if (!title) throw new Error("Enter a title for the new note.");
  if ([...title].length > 200) throw new Error("Keep the title within 200 characters.");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) throw new Error("Use a single-line title without control characters.");
  return title;
}

export function notePathFromTitle(value, parent = "") {
  const title = noteTitle(value);
  const safe = title.replace(/\.(md|markdown)$/i, "").replace(/[<>:"/\\|?*%]+/g, "-").replace(/^[. ]+|[. ]+$/g, "");
  let name = "";
  let bytes = 0;
  for (const character of safe) {
    bytes += markdownByteLength(character);
    if (bytes > 240) break;
    name += character;
  }
  name = name.replace(/[. ]+$/, "");
  if (!name) throw new Error("Use a title with a name, not only spaces or periods.");
  if (isReservedFileName(name)) name = `_${name}`;
  return validateNewNotePath(`${parent ? `${parent}/` : ""}${name}.md`);
}

export function templateContent(kind, value, date = new Date()) {
  const title = noteTitle(value);
  const header = `---\ntitle: ${JSON.stringify(title)}\ncreated: ${JSON.stringify(date.toISOString())}\n`;
  if (kind === "blank") return `${header}---\n\n`;
  const heading = title.replace(/[\\`*_{}[\]()#+.!<>&~-]/g, "\\$&");
  const tag = { daily: "journal", weekly: "weekly", meeting: "meeting" }[kind];
  if (!tag) throw new Error("Choose a supported note template.");
  return `${header}date: ${calendarDate(date)}\ntags: [${tag}]\n---\n\n# ${heading}\n\n` + ({
    daily: "## Priorities\n\n- [ ] \n\n## Notes\n\n\n## Reflection\n\n",
    weekly: "## Highlights\n\n\n## In progress\n\n- [ ] \n\n## Next week\n\n- [ ] \n",
    meeting: "## Attendees\n\n- \n\n## Agenda\n\n- \n\n## Decisions\n\n\n## Action items\n\n- [ ] \n",
  })[kind];
}
