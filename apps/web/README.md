# Web application

The React/TypeScript frontend toolchain is installed: React, Vite, Tailwind's Vite
plugin, type definitions and a type-checked configuration. UI pages and the browser
entry point are intentionally pending the weekly implementation work, so this is
not yet a runnable frontend application.

Vite's configured development address is `127.0.0.1:5173`. The registrar, student,
verifier and auditor flows will be added incrementally. Share API types through
`packages/contracts`; do not import server internals. Import Tailwind from the
application stylesheet when that stylesheet is introduced.
