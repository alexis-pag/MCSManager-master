// Ban commands that regular users must send through the AI-moderated "Ban a player" flow.
const BAN_COMMAND =
  /^\s*\/*\s*(?:[a-z0-9_.-]+:)?(?:ban|ban-ip|banip|ipban|tempban|tempbanip)(?:\s|$)/i;

/** True when a console line is a ban command (`ban x`, `/ban-ip x`, `minecraft:ban x`...). */
export function isBanCommand(line: unknown): boolean {
  if (typeof line !== "string") return false;
  // A single submission may contain several lines (pasted text).
  return line.split(/[\r\n]+/).some((part) => BAN_COMMAND.test(part));
}

export interface FilteredTerminalInput {
  /** Data to write to the process. */
  forward: string;
  /** At least one ban command was erased instead of being submitted. */
  blocked: boolean;
}

// eslint-disable-next-line no-control-regex
const PRINTABLE = /^[^\x00-\x1f\x7f]$/;
const MAX_LINE_CHARS = 4096;

/**
 * Raw PTY keystroke filter for restricted terminal sessions. It models the line being typed;
 * keys that would make that model wrong (history, Tab completion, reverse search, cursor
 * movement, other escape sequences) are dropped, so the modelled line is exactly what the
 * server receives. Enter on a ban command is replaced by backspaces that erase the line.
 */
export class RestrictedTerminalInput {
  private line = "";

  process(input: unknown): FilteredTerminalInput {
    if (typeof input !== "string") return { forward: "", blocked: false };
    let forward = "";
    let blocked = false;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (char === "\x1b") {
        // Drop the whole escape sequence (CSI "\x1b[...X", SS3 "\x1bOX", or Alt+key).
        const next = input[index + 1];
        if (next === "[") {
          index += 2;
          while (index < input.length && !/[@-~]/.test(input[index])) index++;
        } else if (next !== undefined) {
          index += 1;
          if (next === "O") index += 1;
        }
        continue;
      }
      if (char === "\r" || char === "\n") {
        if (isBanCommand(this.line)) {
          forward += "\x7f".repeat(this.line.length);
          blocked = true;
        } else {
          forward += char;
        }
        this.line = "";
        // "\r\n" submits once.
        if (char === "\r" && input[index + 1] === "\n") index++;
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          forward += char;
        }
        continue;
      }
      if (char === "\x03" || char === "\x15" || char === "\x04") {
        // Ctrl+C / Ctrl+U / Ctrl+D clear the current line.
        this.line = "";
        forward += char;
        continue;
      }
      if (PRINTABLE.test(char)) {
        if (this.line.length >= MAX_LINE_CHARS) continue;
        this.line += char;
        forward += char;
      }
      // Any other control key (Tab, Ctrl+R, Ctrl+W, ...) is dropped.
    }
    return { forward, blocked };
  }
}
