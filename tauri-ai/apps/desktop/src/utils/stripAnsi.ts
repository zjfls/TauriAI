/**
 * Strip ANSI/VT100 control sequences from a string.
 *
 * Why not regex?
 * - PTY output can split escape sequences across chunks; a small state machine is safer.
 * - We mainly target CSI (ESC [ ... final) and OSC (ESC ] ... BEL / ESC \).
 */
export function stripAnsi(input: string): string {
  if (!input) return '';

  let out = '';
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input.charCodeAt(i);

    // ESC
    if (ch === 0x1b) {
      i += 1;
      if (i >= len) break;

      const next = input.charCodeAt(i);

      // CSI: ESC [
      if (next === 0x5b) {
        i += 1;
        // parameter bytes: 0x30-0x3F
        while (i < len) {
          const c = input.charCodeAt(i);
          if (c >= 0x30 && c <= 0x3f) {
            i += 1;
            continue;
          }
          break;
        }
        // intermediate bytes: 0x20-0x2F
        while (i < len) {
          const c = input.charCodeAt(i);
          if (c >= 0x20 && c <= 0x2f) {
            i += 1;
            continue;
          }
          break;
        }
        // final byte: 0x40-0x7E
        if (i < len) {
          const c = input.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) {
            i += 1;
          }
        }
        continue;
      }

      // OSC: ESC ]
      if (next === 0x5d) {
        i += 1;
        while (i < len) {
          const c = input.charCodeAt(i);
          // BEL terminator
          if (c === 0x07) {
            i += 1;
            break;
          }
          // ST terminator: ESC \
          if (c === 0x1b && i + 1 < len && input.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }

      // Other ESC sequences: drop ESC + one char (best effort).
      i += 1;
      continue;
    }

    out += input[i];
    i += 1;
  }

  return out;
}

