export function stripCodeFences(text: string): string {
  const s = String(text ?? "");
  // Remove ```json ... ``` or ``` ... ``` blocks wrapping the entire output.
  const fence = s.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) return fence[1] ?? "";
  return s;
}

type BalancedJson = { json: string; end: number };

function extractBalancedJsonAt(s: string, start: number): BalancedJson | null {
  const open = s[start];
  if (open !== "{" && open !== "[") return null;

  const stack: string[] = [open === "{" ? "}" : "]"];
  let inString = false;
  let escape = false;

  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
        continue;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      stack.push("}");
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = stack[stack.length - 1];
      if (ch !== expected) continue;
      stack.pop();
      if (stack.length === 0) {
        return { json: s.slice(start, i + 1).trim(), end: i };
      }
    }
  }

  return null;
}

export function extractFirstJson(text: string): string | null {
  const s = stripCodeFences(text).trim();
  if (!s) return null;

  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  const start =
    firstObj < 0 ? firstArr : firstArr < 0 ? firstObj : Math.min(firstObj, firstArr);
  if (start < 0) return null;

  return extractBalancedJsonAt(s, start)?.json ?? null;
}

export function extractJsonCandidates(text: string, opts?: { limit?: number }): string[] {
  const s = stripCodeFences(text).trim();
  if (!s) return [];

  const limit = Math.max(1, Math.min(200, Math.round(opts?.limit ?? 40)));
  const starts: number[] = [];
  for (let i = 0; i < s.length && starts.length < limit; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") starts.push(i);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    const cand = extractBalancedJsonAt(s, start)?.json;
    if (!cand) continue;
    if (cand.length < 2) continue;
    if (seen.has(cand)) continue;
    seen.add(cand);
    out.push(cand);
  }

  return out;
}

function isHexDigit(ch: string | undefined): boolean {
  return Boolean(ch && /[0-9a-fA-F]/.test(ch));
}

function repairJsonStringEscapes(jsonText: string): string {
  let out = "";
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (!inString) {
      if (ch === "\"") inString = true;
      out += ch;
      continue;
    }

    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\"") {
      inString = false;
      out += ch;
      continue;
    }

    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }

    if (ch !== "\\") {
      out += ch;
      continue;
    }

    const next = jsonText[i + 1];
    if (!next) {
      out += "\\\\";
      continue;
    }

    if (next === "u") {
      const h1 = jsonText[i + 2];
      const h2 = jsonText[i + 3];
      const h3 = jsonText[i + 4];
      const h4 = jsonText[i + 5];
      if (isHexDigit(h1) && isHexDigit(h2) && isHexDigit(h3) && isHexDigit(h4)) {
        out += `\\u${h1}${h2}${h3}${h4}`;
        i += 5;
        continue;
      }
      out += "\\\\";
      continue;
    }

    const isSimpleEscape =
      next === "\"" ||
      next === "\\" ||
      next === "/" ||
      next === "b" ||
      next === "f" ||
      next === "n" ||
      next === "r" ||
      next === "t";
    if (isSimpleEscape) {
      if (next === "b" || next === "f" || next === "n" || next === "r" || next === "t") {
        const after = jsonText[i + 2];
        if (after && /[A-Za-z]/.test(after)) {
          out += "\\\\";
          continue;
        }
      }

      out += "\\";
      escapeNext = true;
      continue;
    }

    out += "\\\\";
  }

  return out;
}

function sanitizeJsonLike(jsonText: string): string {
  // Remove JS-style comments outside strings: //... and /*...*/
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && jsonText[i + 1] === "/") {
      i += 1;
      while (i + 1 < jsonText.length && jsonText[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && jsonText[i + 1] === "*") {
      i += 1;
      while (i + 1 < jsonText.length && !(jsonText[i] === "*" && jsonText[i + 1] === "/")) i++;
      i += 1;
      continue;
    }

    out += ch;
  }

  // Remove trailing commas outside strings: { "a": 1, } or [1,2,]
  let out2 = "";
  inString = false;
  escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      out2 += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      out2 += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j] ?? "")) j++;
      const next = out[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out2 += ch;
  }

  return out2;
}

function countSuspiciousControlChars(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        const code = v.charCodeAt(i);
        if (code < 32 && code !== 10 && code !== 13) count++;
      }
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        stack.push((v as Record<string, unknown>)[k]);
      }
    }
  }
  return count;
}

export function safeJsonParse(text: string): unknown | null {
  const extracted = extractFirstJson(text);
  if (!extracted) return null;
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };

  const attempts: Array<{ value: unknown; priority: number; controlChars: number }> = [];

  const strict = tryParse(extracted);
  if (strict !== null) {
    attempts.push({ value: strict, priority: 0, controlChars: countSuspiciousControlChars(strict) });
  }

  const sanitizedText = sanitizeJsonLike(extracted);
  if (sanitizedText !== extracted) {
    const sanitized = tryParse(sanitizedText);
    if (sanitized !== null) {
      attempts.push({
        value: sanitized,
        priority: 1,
        controlChars: countSuspiciousControlChars(sanitized),
      });
    }
  }

  const repairedText = repairJsonStringEscapes(extracted);
  if (repairedText !== extracted) {
    const repaired = tryParse(repairedText);
    if (repaired !== null) {
      attempts.push({
        value: repaired,
        priority: 2,
        controlChars: countSuspiciousControlChars(repaired),
      });
    }
  }

  const sanitizedRepairedText = repairJsonStringEscapes(sanitizedText);
  if (sanitizedRepairedText !== sanitizedText) {
    const sanitizedRepaired = tryParse(sanitizedRepairedText);
    if (sanitizedRepaired !== null) {
      attempts.push({
        value: sanitizedRepaired,
        priority: 3,
        controlChars: countSuspiciousControlChars(sanitizedRepaired),
      });
    }
  }

  if (attempts.length === 0) return null;
  attempts.sort((a, b) => (a.controlChars - b.controlChars) || (a.priority - b.priority));
  return attempts[0]?.value ?? null;
}
