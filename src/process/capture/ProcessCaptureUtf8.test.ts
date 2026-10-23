import { expect, it } from "vitest";
import type { IPty } from "@lydell/node-pty";
import type { TerminalFrame } from "../../domain/process/processCapture.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { captureTerminalFrames } from "./ProcessCaptureLifecycle.js";
import { createBoundedProcessTextNormalizer } from "./ProcessNormalization.js";

const observe = (chunks: readonly Buffer[]) => {
  let data: ((value: string) => void) | undefined,
    exit: (() => void) | undefined;
  const terminal = {
    onData: (fn: typeof data) => {
      data = fn;
      return { dispose() {} };
    },
    onExit: (fn: typeof exit) => {
      exit = fn;
      return { dispose() {} };
    },
  } as unknown as IPty;
  const scenario = parseProcessScenario({
    executable: "unused",
    normalization: { paths: false, pids: false, ports: false },
  });
  const frames: TerminalFrame[] = [];
  const retained = captureTerminalFrames({
    terminal,
    scenario,
    frames,
    started: 0,
    onOutput() {},
    renderer: { write() {} } as never,
    normalizeText: createBoundedProcessTextNormalizer(scenario, "/tmp", -1),
    recordEvent() {},
  });
  for (const chunk of chunks) data?.(chunk as unknown as string);
  exit?.();
  return {
    text: frames.map((f) => f.raw_data ?? f.data).join(""),
    ...retained(),
  };
};

it("marks invalid bytes and incomplete final sequences as decoding unknown", () => {
  const a = observe([Buffer.from([0x80, 10])]),
    b = observe([Buffer.from([0x81, 10])]);
  expect(a.text).toEqual(b.text);
  expect(a.decoding_unknown).toBe(true);
  expect(b.decoding_unknown).toBe(true);
  expect(observe([Buffer.from([0xe2, 0x82])]).decoding_unknown).toBe(true);
});

it("retains split UTF-8, BOM and a valid literal replacement character without false loss", () => {
  const bytes = Buffer.from("\ufeff한글\ufffd\n");
  const r = observe([...bytes].map((byte) => Buffer.from([byte])));
  expect(r.text).toBe("\ufeff한글\ufffd\n");
  expect(r.decoding_unknown).toBe(false);
  expect(r.raw_terminal.retained_bytes).toBe(bytes.length);
  expect(r.raw_terminal.retained_frames).toBe(r.raw_terminal.observed_frames);
});
