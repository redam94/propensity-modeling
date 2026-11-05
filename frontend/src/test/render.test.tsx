/**
 * Smoke tests: server-render each page/tab against the fixtures to catch
 * runtime errors (undefined access, bad keys) without a browser.
 */
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult, JobDetail } from "../api/types";
import ConfigurePage from "../pages/ConfigurePage";
import ResultsPage from "../pages/ResultsPage";
import RunsPage from "../pages/RunsPage";
import fixtureJson from "./fixtures/analysis_result.json";
import { profileFixture } from "./fixtures/profile";

const result = fixtureJson as unknown as AnalysisResult;
const job: JobDetail = {
  analysis_id: result.analysis_id,
  name: "Fixture run",
  dataset_id: "ds123",
  status: "completed",
  progress: 1,
  stage: null,
  submitted_at: "2026-11-05T10:00:00Z",
  started_at: "2026-11-05T10:00:01Z",
  finished_at: "2026-11-05T10:00:05Z",
  error: null,
  result,
};

function render(path: string, seed: (qc: QueryClient) => void) {
  // useLayoutEffect warns during SSR; silence it for the smoke test
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(qc);
  const html = renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/configure/:datasetId" element={<ConfigurePage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:analysisId" element={<ResultsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  spy.mockRestore();
  return html;
}

describe("page smoke render", () => {
  for (const tab of ["lift", "overlap", "balance", "model", "subgroups", "config"]) {
    it(`renders results tab: ${tab}`, () => {
      const html = render(`/runs/an_fixture?tab=${tab}`, (qc) => { qc.setQueryData(["analysis", "an_fixture"], job); });
      expect(html).toContain("Fixture run");
      expect(html).toContain("Export to Excel");
    });
  }

  it("shows lift numbers in pp on the lift tab", () => {
    const html = render(`/runs/an_fixture?tab=lift`, (qc) => { qc.setQueryData(["analysis", "an_fixture"], job); });
    expect(html).toContain("+12.0 pp");
    expect(html).toContain("&lt;0.001");
  });

  it("renders a running job with progress", () => {
    const running = { ...job, status: "running" as const, progress: 0.4, stage: "matching", result: null };
    const html = render(`/runs/an_fixture`, (qc) => { qc.setQueryData(["analysis", "an_fixture"], running); });
    expect(html).toContain("Matching");
    expect(html).toContain("Cancel run");
  });

  it("renders the configure page from a profile", () => {
    const html = render(`/configure/ds123?sheet=Sheet1`, (qc) => { qc.setQueryData(["dataset", "ds123", "Sheet1"], profileFixture); });
    expect(html).toContain("Column roles");
    expect(html).toContain("purchase_intent");
    expect(html).toContain("Run analysis");
  });

  it("renders the runs list", () => {
    const html = render(`/runs`, (qc) => {
      qc.setQueryData(["analyses"], [job, { ...job, analysis_id: "b", status: "queued", progress: 0 }]);
      qc.setQueryData(["datasets"], [profileFixture]);
    });
    expect(html).toContain("survey.xlsx");
    expect(html).toContain("Waiting for a worker");
  });
});

describe("custom SVG charts render with fixture data", () => {
  it("renders histogram, forest and love plots", async () => {
    const { HistogramChart, ForestPlot, LovePlot } = await import("../components/charts");
    const { histBins, compareMethodsRows } = await import("../lib/chartData");
    const { PALETTES } = await import("../lib/theme");
    const pal = PALETTES.DARK;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = renderToString(
      <HistogramChart
        bins={histBins(result.overlap.histogram)}
        palette={pal}
        density={result.overlap.density}
        support={[result.overlap.common_support_lower, result.overlap.common_support_upper]}
        fixedWidth={800}
      />,
    );
    const o = renderToString(<HistogramChart bins={histBins(result.feature_overlap[0].histogram)} palette={pal} mirror={false} fixedWidth={600} />);
    const f = renderToString(<ForestPlot rows={compareMethodsRows(result.methods, "binary", pal.methods, pal.raw)} palette={pal} unit=" pp" fixedWidth={800} />);
    const l = renderToString(<LovePlot rows={result.methods[0].balance} palette={pal} fixedWidth={800} />);
    spy.mockRestore();
    expect(h).toContain("<svg");
    expect(h).toContain("polyline");
    expect((h.match(/<rect/g) ?? []).length).toBeGreaterThan(10);
    expect(o).toContain("<svg");
    expect(f).toContain("Raw difference");
    expect(f).not.toContain("NaN");
    expect(h).not.toContain("NaN");
    expect(l).toContain("region=North");
    expect(l).not.toContain("NaN");
  });
});
