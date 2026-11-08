TraceDog's landing page uses React, TypeScript, Tailwind CSS and Lucide icons.
The hero is followed by a three-step process, an interactive SVG evidence map,
an interactive public-source flow, a four-step claim-check preview, and a
paired answer benchmarks and a DRACO comparison. The map's employment,
education, and company cases are explicitly fictional; they are a landing-page
demonstration, not a live investigation or a new report feature. Source selection and keyboard
controls work locally with no graph dependency or API calls.

The two benchmark sections use paired BrowseComp/DeepSearchQA bars followed
by a DRACO ranking and source-count charts. TraceDog's 77%, 82%, 74.8 and
65/87/192 counts were supplied by the team on 8 November 2026; run artifacts
are pending. External rows are attributed to Hyperresearch's evaluations,
which are not a TraceDog-controlled shared-harness comparison. Data and
provenance are centralized in `lib/benchmarks.ts`.

`/benchmarks/answers/` and `/benchmarks/draco/` contain original TraceDog
methodology and reproduction protocols with links to the reference studies.
The build emits standalone HTML entry files for both routes, with their own
titles, descriptions, and canonical URLs, using the shared frontend bundle.
192 is labeled sources captured, since the public flow has no shared vault
that later investigations automatically search. No agent or backend changes.

After the benchmarks, a counter starts at 1,308,116,316,541 and grows at
2,000 per second while visible. It is labeled an animated estimate, not a
live index measurement. A pause control, reduced-motion support, and
visibility-aware updates keep the animation accessible and inexpensive.

TraceDog now reports 10 of 10 DRACO tasks. Missing source-validation and
capture reference counts remain null in the data and display as “None”,
meaning no comparable count was reported. The removed provider has no
chart entries or visible copy; source URLs remain in the methodology references.

Start the local UI with `npm run dev -- --port 5173` from `landing`.
The submission form still uses its existing backend; previewing or interacting
with the graph does not launch investigations. `npm test` checks example data,
and the existing intake contract; `npm run build` checks types
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
submission errors. The card heading is “Deploy TraceDog”. Horizontal input tabs also accept a
LinkedIn profile, a social profile URL or platform with @handle, and a Person
with required name and workplace or school, plus an optional claim. These are serialized as
labeled research briefs through the existing text API; no backend changes are
needed. Email appears after entering a profile or the Person name and context.
The left contact button links to ahmedifty.com. The background has a dark
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
