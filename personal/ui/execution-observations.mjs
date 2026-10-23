// Canonical capture owns decoding and omissions; summaries must retain its unknowns.
export function compareObservations(left, right) {
  const a = left.normalized_result,
    b = right.normalized_result;
  const raw = (value) => value.frames.map((f) => f.raw_data ?? f.data).join("");
  const unknown = (value) =>
    value.truncated ||
    value.residual_unknowns?.some((u) => u.scope === "terminal");
  const completed = (value) =>
    value.exit?.reason === "exited" &&
    Number.isInteger(value.exit?.code) &&
    value.settlement?.state === "quiesced";
  return {
    original_output: raw(a),
    candidate_output: raw(b),
    output_equal: unknown(a) || unknown(b) ? null : raw(a) === raw(b),
    original_exit: a.exit,
    candidate_exit: b.exit,
    exit_equal: JSON.stringify(a.exit) === JSON.stringify(b.exit),
    completed: completed(a) && completed(b),
  };
}
