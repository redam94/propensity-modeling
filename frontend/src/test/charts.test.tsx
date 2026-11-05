// @vitest-environment jsdom
/** Regression: charts that first render empty must still measure & draw once data arrives. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../api/types";
import { LovePlot } from "../components/charts";
import { PALETTES } from "../lib/theme";
import realJson from "../__fixtures__/real_result.json";

const result = realJson as unknown as AnalysisResult;
const rows = result.methods.find((m) => m.balance.length)!.balance;
const observed: Element[] = [];

beforeAll(() => {
  class RO {
    cb: ResizeObserverCallback;
    els: Element[] = [];
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      this.els.push(el);
      observed.push(el);
      this.cb([{ target: el, contentRect: { width: 800, height: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {
      for (const el of this.els) observed.splice(observed.indexOf(el), 1);
      this.els = [];
    }
  }
  vi.stubGlobal("ResizeObserver", RO);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
});

afterEach(() => cleanup());

describe("useWidth via LovePlot", () => {
  it("draws after an initial empty render", () => {
    const { container, rerender } = render(<LovePlot rows={[]} palette={PALETTES.LIGHT} />);
    expect(container.querySelector("svg")).toBeNull();
    rerender(<LovePlot rows={rows} palette={PALETTES.LIGHT} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("observes the new element after data -> empty -> data", () => {
    const { container, rerender } = render(<LovePlot rows={rows} palette={PALETTES.LIGHT} />);
    rerender(<LovePlot rows={[]} palette={PALETTES.LIGHT} />);
    expect(observed.length).toBe(0);
    rerender(<LovePlot rows={rows} palette={PALETTES.LIGHT} />);
    const div = container.querySelector("svg")!.parentElement!;
    expect(observed).toEqual([div]);
  });
});
