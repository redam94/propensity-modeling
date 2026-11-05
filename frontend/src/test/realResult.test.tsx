// @vitest-environment jsdom
/**
 * DOM render of every Results tab against a REAL AnalysisResult captured from the
 * backend (sample workbook, all 4 methods, gradient boosting, subgroups, top-box recode).
 * Regenerate src/__fixtures__/real_result.json from GET /api/analyses/{id} -> .result.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult, JobDetail } from "../api/types";
import ResultsPage from "../pages/ResultsPage";
import realJson from "../__fixtures__/real_result.json";

const result = realJson as unknown as AnalysisResult;
const job: JobDetail = {
  analysis_id: result.analysis_id,
  name: result.config.name ?? "Real run",
  dataset_id: result.config.dataset_id,
  status: "completed",
  progress: 1,
  stage: "done",
  submitted_at: result.created_at,
  started_at: result.created_at,
  finished_at: result.created_at,
  error: null,
  result,
};

beforeAll(() => {
  // jsdom lacks layout APIs that recharts' ResponsiveContainer relies on.
  class RO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: 900, height: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 900, height: 400, top: 0, left: 0, right: 900, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network disabled in tests"))));
});

afterEach(() => cleanup());

function renderResults(tab: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["analysis", result.analysis_id], job);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/runs/${result.analysis_id}?tab=${tab}`]}>
        <Routes>
          <Route path="/runs/:analysisId" element={<ResultsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const noBadNumbers = (text: string) => {
  expect(text).not.toMatch(/\bNaN\b/);
  expect(text).not.toMatch(/\bInfinity\b/);
  expect(text).not.toContain("undefined");
};

describe("results page with a real backend result", () => {
  it("fixture is a full multi-method result", () => {
    expect(result.methods.map((m) => m.method).sort()).toEqual(["ipw", "nn_matching", "overlap_weights", "stratification"]);
    expect(result.methods[0].subgroups.length).toBeGreaterThan(0);
  });

  for (const tab of ["lift", "overlap", "balance", "model", "subgroups", "config"]) {
    it(`renders the ${tab} tab without throwing or NaN`, () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { container } = renderResults(tab);
      expect(screen.getByRole("tab", { name: new RegExp(tab, "i") }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText(/Export to Excel/)).toBeTruthy();
      noBadNumbers(container.textContent ?? "");
      if (tab !== "config") expect(container.querySelectorAll("svg path, svg rect").length).toBeGreaterThan(5);
      // no React render errors (key warnings etc. are tolerated, thrown errors are not)
      const thrown = errors.mock.calls.filter((c) => String(c[0]).includes("The above error occurred"));
      expect(thrown).toEqual([]);
      errors.mockRestore();
    });
  }

  it("lift tab shows every outcome and switches methods", () => {
    const { container } = renderResults("lift");
    for (const c of result.methods[0].contrasts) expect(container.textContent).toContain(c.outcome);
    for (const m of result.methods.slice(1)) {
      const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes(m.label.split(" (")[0]));
      expect(btn, m.label).toBeTruthy();
      fireEvent.click(btn!);
      noBadNumbers(container.textContent ?? "");
    }
  });

  it("navigates across all tabs by clicking", () => {
    const { container } = renderResults("lift");
    for (const tab of ["Overlap", "Balance", "Model", "Subgroups", "Config", "Lift"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(tab, "i") }));
      expect(screen.getByRole("tab", { name: new RegExp(tab, "i") }).getAttribute("aria-selected")).toBe("true");
      noBadNumbers(container.textContent ?? "");
    }
  });
});
