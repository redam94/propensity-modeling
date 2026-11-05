# Lift Analyzer — frontend

Vite + React 18 + TypeScript (strict), react-router, @tanstack/react-query, recharts.

```bash
npm install
npm run dev          # http://localhost:5173, proxies /api -> http://localhost:8000 (override: API_TARGET=http://host:port)
npm test             # vitest (formatters, config builder, chart data, SSR smoke render of every page/tab)
npm run build        # tsc --noEmit && vite build -> dist/
```

* `src/api/types.ts` mirrors `packages/propensity_lift/src/propensity_lift/schemas.py` 1:1.
* `src/api/client.ts` typed fetch wrappers; FastAPI `detail` (string or 422 list) becomes readable `ApiError.message`.
* `src/lib/configBuilder.ts` role grid state -> `AnalysisConfig` + client-side validation.
* `src/components/charts.tsx` custom SVG mirrored/overlaid histogram, forest plot, love plot.
* Exposed = orange/vermillion, Control = blue (Okabe–Ito, colour-blind safe) everywhere; light/dark via `prefers-color-scheme`.
