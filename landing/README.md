TraceDog's landing page uses React, TypeScript, Tailwind CSS and Lucide icons.
The hero is followed by a three-step process, an interactive SVG evidence map,
sample report counts, and expandable methodology notes. The map's employment,
education, and company cases are explicitly fictional; they are a landing-page
demonstration, not a live investigation or a new report feature. Relationship
filters, source selection, keyboard controls, and zoom/reset work locally with
no graph dependency or API calls.

The results section uses aggregates from published run
`f6d68f56-9ae6-49fe-9838-deee2697d28e` (14 October 2026): 24 findings,
22 distinct cited URLs, and 21 findings with at least one source. Outcomes are
8 established, 7 partial, 6 unresolved, 1 conflicting, and 2 contradicted.
These are single-report counts, not comparative benchmark results. The public
data in `lib/evidence.ts` includes no personal report content.

Start the local UI with `npm run dev -- --port 5173` from `landing`.
The submission form still uses its existing backend; previewing or interacting
with the graph does not launch investigations. `npm test` checks graph filtering,
sample totals, and the existing intake contract; `npm run build` checks types
and produces the static bundle. Responsive browser checks cover 320, 768,
1024, and 1440 pixels.

The supplied glassmorphism view lives in `components/ui`; this is the UI
component directory configured in `components.json`. The `@/` alias resolves
from this frontend package. The old HTML/CSS/JavaScript frontend is removed.

Build with `npm ci --legacy-peer-deps && npm run build` from `landing`.
Run the web service from the repository root to serve `landing/dist` and the
existing submission API together on port 8787. `npm run dev` is available for
frontend editing; run the backend alongside it for submissions. The Docker
web image builds the frontend in a separate stage. Render's static blueprint
also builds this package before publishing `dist`.

The form supports a PDF up to 2 MB and two pages, a text file, or pasted text
and a work email. It reveals work email after selecting a file or entering 15 words. Text submissions
must contain 15–1,500 whitespace-separated words; these limits appear only as
submission errors. The card heading rotates through Resume, Profile and Claim,
and the left contact button links to ahmedifty.com. The background has a dark
blur overlay. It uses the existing `/api/submissions` endpoint and the same blocked-domain list
as the backend. `npm test` checks the payload and input limits. Browser tests
can mock the submission response to avoid launching paid investigations.

For the serverless deployment, set the public endpoint in `.env.example`;
provider keys remain in the Edge Function. See `../docs/tracedog-serverless.md`.

Verified: production build under Node 22, 216 backend tests, three input tests,
and Chrome at 320/768/1024/1440px. PDF, pasted text and text-file flows,
personal-email rejection, file replacement and error recovery passed with
mocked submission responses. The Docker build was not run because the local
Docker daemon was unavailable.

Build references: [Tailwind's Vite setup](https://tailwindcss.com/docs/installation/using-vite),
[Vite's build guide](https://vite.dev/guide/build.html), and
[React's root API](https://react.dev/reference/react-dom/client/createRoot).
