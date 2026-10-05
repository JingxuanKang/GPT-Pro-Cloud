/**
 * Local IME composition → CDP.
 * Pinyin is composed in the member's browser. The desk must not turn those
 * keydowns into X keysyms (the keysym table fills up, and Linux has no IME).
 * Preview with Input.imeSetComposition; commit with Input.insertText, which
 * replaces the active composition.
 */

export const IME_TEXT_MAX = 4000;

const PHASES = new Set(["start", "update", "commit", "cancel"]);

export function cleanImeText(text) {
  return String(text ?? "").replace(/\u0000/g, "");
}

export function imeCommands(msg = {}) {
  const phase = String(msg.phase || "");
  if (!PHASES.has(phase)) return { ok: false, error: "无法输入", status: 400 };
  const text = cleanImeText(msg.text);
  if (text.length > IME_TEXT_MAX) return { ok: false, error: "输入过长", status: 413 };
  const end = text.length;
  if (phase === "update") {
    return {
      ok: true,
      phase,
      commands: [
        {
          method: "Input.imeSetComposition",
          params: { text, selectionStart: end, selectionEnd: end },
        },
      ],
    };
  }
  if (phase === "commit") {
    if (!text) {
      return {
        ok: true,
        phase,
        commands: [{ method: "Input.imeSetComposition", params: { text: "", selectionStart: 0, selectionEnd: 0 } }],
      };
    }
    return {
      ok: true,
      phase,
      commands: [{ method: "Input.insertText", params: { text } }],
    };
  }
  if (phase === "cancel") {
    return {
      ok: true,
      phase,
      commands: [{ method: "Input.imeSetComposition", params: { text: "", selectionStart: 0, selectionEnd: 0 } }],
    };
  }
  return { ok: true, phase, commands: [] };
}

export async function applyImeCommands(send, msg) {
  const plan = imeCommands(msg);
  if (!plan.ok) return plan;
  for (const cmd of plan.commands) {
    await send(cmd.method, cmd.params);
  }
  return plan;
}
