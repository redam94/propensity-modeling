import type { MethodResult } from "../../api/types";
import { fmtInt, fmtNum } from "../../lib/format";
import { usePalette } from "../../lib/theme";

export function MethodPicker({
  methods,
  value,
  onChange,
}: {
  methods: MethodResult[];
  value: string;
  onChange: (m: string) => void;
}) {
  const pal = usePalette();
  if (methods.length <= 1) return null;
  return (
    <div className="seg" role="group" aria-label="Adjustment method">
      {methods.map((m) => (
        <button key={m.method} type="button" className={m.method === value ? "on" : ""} onClick={() => onChange(m.method)} title={m.label}>
          <span className="dot" style={{ background: pal.methods[m.method], marginRight: 6 }} />
          {m.label.length > 28 ? m.label.split("(")[0].trim() : m.label}
        </button>
      ))}
    </div>
  );
}

export function MethodInfo({ method }: { method: MethodResult }) {
  return (
    <div className="row small muted" style={{ gap: 18 }}>
      <span>
        Used: <b style={{ color: "var(--exposed)" }}>{fmtInt(method.n_exposed_used)}</b> exposed ·{" "}
        <b style={{ color: "var(--control)" }}>{fmtInt(method.n_control_used)}</b> control
      </span>
      {method.matching && (
        <>
          <span>
            Matched {fmtInt(method.matching.n_exposed_matched)} / unmatched {fmtInt(method.matching.n_exposed_unmatched)} exposed
          </span>
          <span>{fmtInt(method.matching.n_unique_controls_used)} unique controls</span>
          <span>caliper {method.matching.caliper_abs == null ? "none" : fmtNum(method.matching.caliper_abs, 3)} (logit)</span>
          {method.matching.n_exact_strata > 1 && <span>{fmtInt(method.matching.n_exact_strata)} exact strata</span>}
        </>
      )}
      {method.weights && (
        <>
          <span>
            weights {fmtNum(method.weights.min, 2)}–{fmtNum(method.weights.max, 2)} (mean {fmtNum(method.weights.mean, 2)})
          </span>
          <span>
            ESS {fmtNum(method.weights.ess_exposed, 0)} exp. / {fmtNum(method.weights.ess_control, 0)} ctl.
          </span>
          {method.weights.n_clipped > 0 && <span>{fmtInt(method.weights.n_clipped)} clipped</span>}
        </>
      )}
    </div>
  );
}
