TraceDog's landing page uses React, TypeScript, Tailwind CSS and Lucide icons.
The supplied glassmorphism view lives in `components/ui`; this is the UI
component directory configured in `components.json`. The `@/` alias resolves
from this frontend package. The old HTML/CSS/JavaScript frontend is removed.

Build with `npm ci --legacy-peer-deps && npm run build` from `landing`.
Run the web service from the repository root to serve `landing/dist` and the
existing submission API together on port 8787. `npm run dev` is available for
frontend editing; run the backend alongside it for submissions. The Docker
web image builds the frontend in a separate stage. Render's static blueprint
also builds this package before publishing `dist`.

The form supports a PDF, a text file, or pasted text and a work email. It
reveals work email after selecting a file or entering 15 words. Text submissions
must contain 15–1,500 whitespace-separated words; these limits appear only as
submission errors. The background has a dark blur overlay. It uses the
existing `/api/submissions` endpoint and the same blocked-domain list
as the backend. `npm test` checks the payload and input limits. Browser tests
can mock the submission response to avoid launching paid investigations.

Verified: production build under Node 22, 208 backend tests, three input tests,
and Chrome at 320/768/1024/1440px. PDF, pasted text and text-file flows,
personal-email rejection, file replacement and error recovery passed with
mocked submission responses. The Docker build was not run because the local
Docker daemon was unavailable.

Build references: [Tailwind's Vite setup](https://tailwindcss.com/docs/installation/using-vite),
[Vite's build guide](https://vite.dev/guide/build.html), and
[React's root API](https://react.dev/reference/react-dom/client/createRoot).
